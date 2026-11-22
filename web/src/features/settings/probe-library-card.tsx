import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import {
  probeLibraryQueryOptions,
  type ProbeLibraryEntry,
} from '@/features/settings/queries'

type Obj = Record<string, unknown>

const STATUS_TEXT: Record<ProbeLibraryEntry['status'], string> = {
  candidate: '学习中',
  active: '回放中',
  blocked: '已拉黑',
}

function intOr(raw: string, fallback: number) {
  const n = Math.round(Number(raw))
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function ProbeLibraryCard({
  library,
  onChange,
}: {
  library: Obj
  onChange: (patch: Obj) => void
}) {
  const qc = useQueryClient()
  const status = useQuery(probeLibraryQueryOptions())
  const act = useMutation({
    mutationFn: ({ fp, action }: { fp: string; action: string }) =>
      api(`/api/panel/probe-library/${encodeURIComponent(fp)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['panel', 'probe-library'] }),
    onError: (error) => toast.error(String((error as Error)?.message || error)),
  })
  const stats = status.data?.stats
  const entries = status.data?.entries || []
  const num = (key: string, fallback: number) => Number(library[key] ?? fallback)
  return (
    <Card>
      <CardHeader>
        <CardTitle>探针库</CardTitle>
        <p className='text-xs text-muted-foreground'>
          按内容指纹学习第三方探针（单轮短文本、小 max_tokens、无工具，官方 Claude
          Code 除外）。同一指纹被足够多不同密钥打通后转为回放：不占槽位、会话席位，按缓存
          usage 正常计费。每个刷新间隔放行一次真实请求更新回复；超过有效期未刷新成功则恢复直连。
          仅 Claude 模型。
        </p>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow label='启用' desc='关闭时不学习也不回放'>
          <Switch
            checked={library.enabled === true}
            onCheckedChange={(checked) => onChange({ enabled: checked })}
            aria-label='启用探针库'
          />
        </SettingRow>
        <SettingRow label='只观察' desc='照常学习并统计「本可命中」次数，但始终打上游'>
          <Switch
            checked={library.dry_run === true}
            onCheckedChange={(checked) => onChange({ dry_run: checked })}
            aria-label='只观察'
          />
        </SettingRow>
        {(
          [
            ['promote_min_keys', '转正所需密钥数', '不同密钥打通同一探针的次数', 3],
            ['max_prompt_chars', '最长提问字数', '用户文本超过即不算探针', 64],
            ['max_tokens', '最大 max_tokens', '超过即不算探针', 64],
            ['max_system_chars', '最长 system 字数', '0 = 带 system 的请求不算探针', 0],
            ['refresh_sec', '刷新间隔', '秒；到期放行一次真实请求', 1800],
            ['ttl_sec', '有效期', '秒；超过且未刷新成功则不再回放', 21600],
          ] as const
        ).map(([key, label, desc, fallback]) => (
          <SettingRow key={key} label={label} desc={desc}>
            <Input
              className='w-28'
              type='number'
              min={0}
              value={num(key, fallback)}
              onChange={(event) => onChange({ [key]: intOr(event.target.value, fallback) })}
              aria-label={label}
            />
          </SettingRow>
        ))}
        <div className='space-y-2 py-3'>
          <p className='text-xs text-muted-foreground'>
            {stats
              ? `共 ${stats.entries} 条 · 回放中 ${stats.active} · 学习中 ${stats.candidate} · 已拉黑 ${stats.blocked} · 命中 ${stats.hits} · 本可命中 ${stats.dry_hits} · 回源 ${stats.upstream}`
              : '暂无数据'}
          </p>
          <div className='max-h-96 overflow-auto'>
            <table className='w-full text-xs'>
              <thead className='text-left text-muted-foreground'>
                <tr>
                  <th className='py-1 pr-2'>提问</th>
                  <th className='py-1 pr-2'>模型</th>
                  <th className='py-1 pr-2'>回复</th>
                  <th className='py-1 pr-2'>密钥</th>
                  <th className='py-1 pr-2'>命中/回源</th>
                  <th className='py-1 pr-2'>状态</th>
                  <th className='py-1' />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.fingerprint} className='border-t align-top'>
                    <td className='max-w-48 truncate py-1 pr-2' title={e.sample_text}>
                      {e.sample_text}
                    </td>
                    <td className='py-1 pr-2'>
                      {e.model_family} · {e.max_tokens || '—'}
                    </td>
                    <td className='max-w-48 truncate py-1 pr-2' title={e.last_error || e.reply_text}>
                      {e.reply_text || '—'}
                    </td>
                    <td className='py-1 pr-2'>{e.distinct_keys}</td>
                    <td className='py-1 pr-2'>
                      {e.hit_count}/{e.upstream_count}
                    </td>
                    <td className='py-1 pr-2'>
                      <Badge
                        variant={
                          e.status === 'active' ? (e.fresh ? 'default' : 'secondary') : e.status === 'blocked' ? 'destructive' : 'outline'
                        }
                        title={e.last_error || undefined}
                      >
                        {STATUS_TEXT[e.status]}
                      </Badge>
                    </td>
                    <td className='flex gap-1 py-1'>
                      {e.status !== 'active' && (
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={!e.reply_text || act.isPending}
                          onClick={() => act.mutate({ fp: e.fingerprint, action: 'activate' })}
                        >
                          回放
                        </Button>
                      )}
                      {e.status !== 'blocked' && (
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={act.isPending}
                          onClick={() => act.mutate({ fp: e.fingerprint, action: 'block' })}
                        >
                          拉黑
                        </Button>
                      )}
                      <Button
                        size='sm'
                        variant='ghost'
                        disabled={act.isPending}
                        onClick={() => act.mutate({ fp: e.fingerprint, action: 'delete' })}
                      >
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
