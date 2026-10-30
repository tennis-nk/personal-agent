import { isModelReady } from '../ai/agent'

/**
 * 离线模式提示。
 *
 * 只在没有接入模型时出现，用来说明结果的来源，
 * 免得把规则引擎的统计输出误当成模型的理解结果。
 */
export function ModeHint({ text }: { text?: string }) {
  if (isModelReady()) return null
  return (
    <div className="small muted" style={{ marginTop: 8 }}>
      {text ??
        '当前为离线模式：没有接入大模型，结果由本地规则引擎生成。到「设置」填入模型接口地址、API Key 与模型名即可切换。'}
    </div>
  )
}
