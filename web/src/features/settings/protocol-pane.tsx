import {
  SESSION_IDLE_TTL_SECONDS_DEFAULT,
  SESSION_IDLE_TTL_SECONDS_MAX,
  SESSION_IDLE_TTL_SECONDS_MIN,
} from '@/types/panel-routing'
import {
  Brain,
  Check,
  Clock3,
  Database,
  Scaling,
  ChevronRight,
  ShieldCheck,
} from 'lucide-react'
import { useState } from 'react'
import {
  cacheTtlFromCompat,
  detectProxiedOfficialCcFromCompat,
} from '@/lib/cache-breakpoints'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import { OutboundReference } from './outbound-reference'
import {
  cchEnabledFromCompat,
  ccEntrypointFromCompat,
  sessionIdleTtlFromInference,
  thinkingDisplayFromCompat,
} from './protocol-authority'
import { ChipGroup, PaneSection, StepperSetting } from './scheduler-controls'

type Block = Record<string, unknown>

type ClientAction = 'off' | 'relocate' | 'block'

/** Mirrors THIRD_PARTY_CLIENTS in src/lib/identity/third-party-clients.mjs. */
const THIRD_PARTY_CLIENTS: [string, string][] = [
  ['openclaw', 'OpenClaw'],
  ['opencode', 'OpenCode'],
  ['cline', 'Cline'],
  ['roo', 'Roo Code'],
  ['kilo', 'Kilo Code'],
  ['crush', 'Crush'],
  ['goose', 'goose'],
  ['deepseek-harness', 'DeepSeek Harness'],
  ['pi', 'pi'],
  ['codex', 'Codex'],
  ['copilot-cli', 'Copilot CLI'],
  ['cherry', 'Cherry Studio'],
]

const CLIENT_ACTIONS: [ClientAction, string][] = [
  ['off', '放行'],
  ['relocate', '搬迁'],
  ['block', '拦截'],
]

/** Unset falls back to the legacy blocked_clients switch, else relocate. */
function clientActionOf(
  id: string,
  map: Record<string, unknown>,
  legacy: Record<string, unknown>
): ClientAction {
  const v = map[id]
  if (v === 'off' || v === 'relocate' || v === 'block') return v
  return legacy[id] === true ? 'block' : 'relocate'
}

function ThirdPartyClients({
  compat,
  onCompatChange,
}: {
  compat: Block
  onCompatChange: (next: Block) => void
}) {
  const [open, setOpen] = useState(false)
  const asMap = (v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {}
  const map = asMap(compat.third_party_clients)
  const legacy = asMap(compat.blocked_clients)
  const actions = THIRD_PARTY_CLIENTS.map(([id, label]) => ({
    id,
    label,
    action: clientActionOf(id, map, legacy),
  }))
  const count = (a: ClientAction) => actions.filter((x) => x.action === a).length
  const set = (id: string, action: ClientAction) => {
    // Persist every row explicitly and drop the legacy key: it is merged in here.
    const next: Record<string, ClientAction> = {}
    for (const x of actions) next[x.id] = x.id === id ? action : x.action
    const { blocked_clients: _legacy, ...rest } = compat
    onCompatChange({ ...rest, third_party_clients: next })
  }
  return (
    <div className='py-3 first:pt-0 last:pb-0'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className='flex w-full items-center gap-2 text-start'
      >
        <ChevronRight
          className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        <span className='text-sm font-medium'>第三方客户端</span>
        <span className='ms-auto text-xs text-muted-foreground'>
          搬迁 {count('relocate')} · 拦截 {count('block')} · 放行 {count('off')}
        </span>
      </button>
      {open ? (
        <div className='mt-2 space-y-1 ps-6'>
          {actions.map(({ id, label, action }) => (
            <div key={id} className='flex items-center justify-between gap-3 py-1'>
              <span className='text-sm'>{label}</span>
              <div className='inline-flex rounded-md border p-0.5 text-xs' role='radiogroup' aria-label={label}>
                {CLIENT_ACTIONS.map(([value, text]) => (
                  <button
                    key={value}
                    type='button'
                    role='radio'
                    aria-checked={action === value}
                    onClick={() => set(id, value)}
                    className={cn(
                      'rounded px-2.5 py-0.5 transition-colors',
                      action === value
                        ? value === 'block'
                          ? 'bg-destructive/15 text-destructive'
                          : value === 'relocate'
                            ? 'bg-primary/15 text-primary'
                            : 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <p className='pt-1 text-xs text-muted-foreground'>
            放行＝原样转发；搬迁＝system 移入首条消息并替换客户端名；拦截＝403，不选号。
          </p>
        </div>
      ) : null}
    </div>
  )
}

/** Mirrors `hasClaudeCodeClientHeaders` + body checks in src/lib/identity/claude-code-only.mjs. */
const CLAUDE_CODE_FINGERPRINT: [string, string][] = [
  ['UA', 'claude-cli/x.y.z'],
  ['x-app', 'cli'],
  ['anthropic-beta', 'claude-code-20250219'],
  ['Stainless SDK', 'x-stainless-lang: js'],
  ['会话头', '= user_id.session_id'],
  ['system', '官方计费块 / 身份行'],
  ['计费块', 'cc_version = UA 版本'],
]

function autoCompactWindowValue(value: unknown) {
  const tokens = Number(value)
  if (tokens === 200_000 || tokens === 500_000 || tokens === 1_000_000)
    return String(tokens)
  return 'model'
}

export function ProtocolPane({
  compat,
  inference,
  onCompatChange,
  onInferenceChange,
}: {
  compat: Block
  inference: Block
  onCompatChange: (next: Block) => void
  onInferenceChange: (patch: Block) => void
}) {
  const strict = compat.claude_code_only === true
  const countTokens = compat.count_tokens === true
  const relay = detectProxiedOfficialCcFromCompat(compat)
  const cch = cchEnabledFromCompat(compat)
  return (
    <div className='space-y-4'>
      <PaneSection
        icon={ShieldCheck}
        title='入站准入'
        desc='谁能调用 Claude。GPT 准入在 OpenAI 页。'
        aside={
          <Badge variant={strict ? 'default' : 'secondary'}>
            {strict ? 'Claude 仅限 Claude Code' : 'Claude 不限客户端'}
          </Badge>
        }
      >
        <div className='divide-y'>
          <SettingRow
            label='仅允许 Claude Code 家族请求'
            desc={
              strict
                ? '第三方客户端一律 403，返回“请使用 Claude 官方客户端”，不选号、不上游。'
                : '已关：第三方客户端放行，其 system 自动搬进首条 user，避开上游「Third-party apps」计费拒绝。'
            }
          >
            <Switch
              checked={strict}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, claude_code_only: on })
              }
              aria-label='仅允许 Claude Code 家族请求'
            />
          </SettingRow>
          <SettingRow
            label='识别中转来的官方 Claude Code'
            desc={
              relay
                ? 'UA 被改写但系统里有官方计费块的请求按官方处理，准入也放行。计费块被丢掉时，还要官方 system 和合法 user_id。'
                : '已关：只认直连 Claude Code，中转流量按第三方处理。'
            }
          >
            <Switch
              checked={relay}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, detect_proxied_official_cc: on })
              }
              aria-label='识别中转来的官方 Claude Code'
            />
          </SettingRow>
          <SettingRow
            label='官方 Claude Code 家族透传'
            desc={
              compat.official_cc_passthrough === true
                ? '开：直连和被识别为中转的官方家族保留入站 system，不套用当前提示词档。'
                : '关：官方家族也套用协议里的 system 档。打开后才透传。'
            }
          >
            <Switch
              checked={compat.official_cc_passthrough === true}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, official_cc_passthrough: on })
              }
              aria-label='官方 Claude Code 家族透传'
            />
          </SettingRow>
          <ThirdPartyClients compat={compat} onCompatChange={onCompatChange} />
          <SettingRow
            label='开放 count_tokens 入口'
            desc={
              countTokens
                ? '开：POST /v1/messages/count_tokens 与面板按槽位的计数探测可用。只算 token，不绑定 sticky、不计费。'
                : '已关：上述两个入口返回 404。实现一直在，这个开关只决定是否放行。'
            }
          >
            <Switch
              checked={countTokens}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, count_tokens: on })
              }
              aria-label='开放 count_tokens 入口'
            />
          </SettingRow>
        </div>
        <div
          className={cn(
            'space-y-3 pt-3 transition-opacity duration-200',
            !strict && 'opacity-55'
          )}
        >
          <p className='text-xs text-muted-foreground'>
            {strict ? '直连放行须同时满足' : '开启后直连放行须同时满足'}
          </p>
          <ul className='grid gap-x-4 gap-y-1.5 sm:grid-cols-2'>
            {CLAUDE_CODE_FINGERPRINT.map(([name, value]) => (
              <li key={name} className='flex min-w-0 items-start gap-2 text-xs'>
                <Check
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    strict ? 'text-primary' : 'text-muted-foreground'
                  )}
                  aria-hidden
                />
                <span className='min-w-0'>
                  <span className='font-medium'>{name}</span>{' '}
                  <span className='font-mono break-all text-muted-foreground'>
                    {value}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className='text-xs leading-5 text-muted-foreground'>
            OpenAI 格式入口与健康探测一律拒绝。count_tokens 只验请求头；CLI
            自身的 quota 探测须是固定原样。面板测试与内部探测不受影响。
          </p>
        </div>
      </PaneSection>
      <PaneSection
        icon={Database}
        title='提示词缓存'
        desc='设置默认缓存写入时长，保持现有断点布局。'
      >
        <SettingRow
          label='默认缓存写入 TTL'
          desc='请求头、请求显式 TTL 与会话锁定值优先；system 模板中的显式 TTL 不变。'
        >
          <ChipGroup
            label='默认缓存写入 TTL'
            value={cacheTtlFromCompat(compat)}
            options={[
              ['5m', '5 分钟（5m）'],
              ['1h', '1 小时（1h）'],
            ]}
            onChange={(cache_ttl) => onCompatChange({ ...compat, cache_ttl })}
          />
        </SettingRow>
        <p className='text-xs leading-5 text-muted-foreground'>
          保存后作为新会话和自有缺省标记的
          TTL。已有会话锁定值不变，官方透传仍保留调用方断点及缺失 TTL。
        </p>
      </PaneSection>
      <PaneSection
        icon={Database}
        title='出站入口'
        desc='billing 的 cc_entrypoint 和出站 UA 用同一个值。调用方自带的 billing 不改。'
      >
        <SettingRow
          label='cc_entrypoint'
          desc='保存后写入各 Claude 槽 kernel.json，cli-node 下次请求读取。'
        >
          <ChipGroup
            label='cc_entrypoint'
            value={ccEntrypointFromCompat(compat)}
            options={[
              ['sdk-cli', 'sdk-cli'],
              ['cli', 'cli'],
            ]}
            onChange={(cc_entrypoint) =>
              onCompatChange({ ...compat, cc_entrypoint })
            }
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Brain}
        title='thinking 显示'
        desc='调用方打开 thinking 却要求隐藏时，出站改成返回摘要。计费不变。'
      >
        <SettingRow
          label='隐藏的 thinking 改为返回摘要'
          desc={
            thinkingDisplayFromCompat(compat) === 'summarized'
              ? '开：omitted、updates，以及默认隐藏的模型上没写 display 的请求，出站改成 summarized。'
              : '关：保留调用方的 display。updates 仍只在出站 beta 声明时保留，否则降成 omitted。'
          }
        >
          <Switch
            checked={thinkingDisplayFromCompat(compat) === 'summarized'}
            onCheckedChange={(on) =>
              onCompatChange({
                ...compat,
                thinking_display: on ? 'summarized' : 'passthrough',
              })
            }
            aria-label='隐藏的 thinking 改为返回摘要'
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Scaling}
        title='Auto compact 窗口'
        desc='默认跟随请求模型。显式值替换模型窗口，请求里的 CLAUDE_CODE_AUTO_COMPACT_WINDOW 仍优先。'
      >
        <SettingRow
          label='窗口'
          desc='跟随模型时，Opus / Sonnet / Haiku 5.x 使用 1M，其余模型使用 200K。'
        >
          <ChipGroup
            label='Auto compact 窗口'
            value={autoCompactWindowValue(compat.auto_compact_window)}
            options={[
              ['model', '跟随模型'],
              ['200000', '200K'],
              ['500000', '500K'],
              ['1000000', '1M'],
            ]}
            onChange={(value) =>
              onCompatChange({
                ...compat,
                auto_compact_window: value === 'model' ? null : Number(value),
              })
            }
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Clock3}
        title='CCH 统一附加'
        desc='出站 billing 的 cch。开启后缺失也补，不区分试用或订阅。'
      >
        <SettingRow
          label='强制附加 CCH'
          desc={
            cch
              ? '开：出站补齐 cch；试用号缺失也写。保存后热写入各槽 kernel.json，不重启 CLI。'
              : '关：固定发送 cch=00000;（5 个 0），不计算摘要。'
          }
        >
          <Switch
            checked={cch}
            onCheckedChange={(on) =>
              onCompatChange({ ...compat, cch_enabled: on })
            }
            aria-label='强制附加 CCH'
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Clock3}
        title='原生 sticky 槽'
        desc='kernel 里 CLI 槽空闲回收。不是流空闲超时，也不是粘性页的账号绑定 TTL。'
      >
        <StepperSetting
          id='inference-session-idle-ttl'
          label='槽空闲超时'
          desc='从最后一次任务完成开始计时，活动请求不回收。保存后热生效，不重启内核。'
          value={sessionIdleTtlFromInference(inference)}
          min={SESSION_IDLE_TTL_SECONDS_MIN}
          max={SESSION_IDLE_TTL_SECONDS_MAX}
          unit='秒'
          fallback={SESSION_IDLE_TTL_SECONDS_DEFAULT}
          onChange={(value) =>
            onInferenceChange({ session_idle_ttl_seconds: value })
          }
        />
      </PaneSection>
      <OutboundReference />
    </div>
  )
}
