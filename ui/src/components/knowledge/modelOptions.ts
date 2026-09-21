import { getSettings } from '@/api/client'
import { modelKey, type ModelChannel } from '@/api/engine'

/**
 * 每库的 embedding / rerank 选择项。
 * <p>
 * 值沿用全局那套「渠道::模型」复合键——渠道（base_url / key）在「设置 → 模型云服务」里配，
 * 这里只挑用哪条，不重复填地址和密钥。库上选了就用库上的，不选才回落到全局默认。
 */
export interface ModelOption {
  key: string
  label: string
}

/** 某个用途下的可选项：每个模型 id 一条 */
export function optionsOfKind(channels: ModelChannel[], kind: 'embedding' | 'rerank'): ModelOption[] {
  const out: ModelOption[] = []
  for (const ch of channels) {
    if ((ch.kind || 'chat') !== kind) continue
    const ids = ch.models && ch.models.length ? ch.models : ch.model ? [ch.model] : []
    for (const id of ids) out.push({ key: modelKey(ch.name, id), label: `${ch.name} · ${id}` })
  }
  return out
}

/**
 * 读一份渠道列表。建库 / 设置两处都要用，读失败就返回空数组——
 * 模型选项加载不到不该让整个知识库页打不开。
 */
export async function loadModelChannels(): Promise<ModelChannel[]> {
  try {
    const s = await getSettings()
    return ((s.models as ModelChannel[]) || []).map((m) => ({ ...m }))
  } catch {
    return []
  }
}
