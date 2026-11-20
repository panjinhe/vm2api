# CRAG 3.1.7 开遥测后的 Datadog 上报抓包

对应 issue：dofastted/vm2api#1387。

## 环境

- 控制面 v1.4.156，CRAG payload 3.1.7（native-v3），claude-code 2.1.321，Debian 12 槽（Pro 套餐，内存上限 2g）。
- 槽开启遥测：`seed_policy.telemetry_disabled=false`。

## 流量对比

同一版本、同样发 2 条 "hi"，在槽网络命名空间里抓包：

| | 遥测开 | 遥测关 |
|---|---|---|
| 进程环境 | `CRAG_GUEST_ENABLE_TELEMETRY=1`、`CRAG_GUEST_TELEMETRY_ALLOWLIST`（3 事件白名单）、`LD_PRELOAD=libtelemetry-guest.so` | 只有 `LD_PRELOAD` |
| DNS 查询 | api.anthropic.com、downloads.claude.ai、`http-intake.logs.us5.datadoghq.com` | api.anthropic.com、downloads.claude.ai |
| 发往 Datadog（34.149.66.165）出站 | 约 159 KB，27 包，2 次请求 | 0 |

## 解包方法

1. 宿主机：把槽网桥发往 34.149.66.165:443 的流量 DNAT 到自建 TLS 监听（自签 CA，证书 SAN 为 Datadog 域名），监听记录请求头与 gunzip 后的 body。
2. 槽：`PUT /api/panel/vms/:id/seed-settings` 设 `extra_env.NODE_EXTRA_CA_CERTS` 指向槽内可写目录下的 CA 文件（rootfs 只读）。claude 信任该 CA。
3. 钉槽发一条 "hi"，监听收到 1 次 `POST /api/v2/logs`（`User-Agent: axios/1.15.2`）。
4. 结束后撤销 DNAT、extra_env、CA 文件。

## 结果

- `events-crag-cli.json`：该批次的 39 条事件，原样（已 JSON 格式化）。`field-list.txt`：329 个字段名。
- 来源：claude 二进制（bun 打包，JS 明文）里的 Datadog 日志发送器，只发 `tengu_*` / `chrome_bridge_*` 白名单事件，附带整套环境元数据；这条路径不经过 `native-telemetry.mjs`，该文件只处理 `https://api.anthropic.com/api/event_logging/v2/batch`。

### 字段要点

- 无 email、account/org UUID、device_id、token、提示词。
- 账号相关：`subscription_type`、`auth_kind`、`token_source`、`credential`、`user_bucket`。
- 会话相关：`session_id`、`prompt_id`、`request_id`、`client_request_id`、`query_chain_id`、`last_session_id`、`last_session_cost`、`last_session_total_*_tokens`。
- 已被 CRAG 伪装且一致：`linux_kernel`（6.1.0-28-amd64）、`linux_distro_id/version`（debian 12）、`terminal`（xterm-256color）、`entrypoint`/`client_type`（cli）。
- **未伪装**：`deployment_environment = "docker"`、`process_metrics.constrainedMemory = 2147483648`。

### 这两项的来源（claude 2.1.321 二进制）

- `deployment_environment`：`CE()` 依次检查 CODESPACES / GITPOD / VERCEL / KUBERNETES_SERVICE_HOST / 各 CI 等环境变量，最后 `isDockerenvPresent()`（`/.dockerenv` 存在）返回 `docker`，否则按平台返回 `unknown-linux`。没有环境变量能把它变成 `unknown-linux`。
- `constrainedMemory`：`process.constrainedMemory()`，读 cgroup `memory.max`。
