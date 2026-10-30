/**
 * 课表图片识别。
 *
 * 走用户自己配的大模型视觉接口（OpenAI 兼容），本地不做 OCR：
 * 浏览器里装不了 OCR 引擎，而各家视觉模型读表格的准确度已经够用。
 * 识别结果一律先填进文本框给用户过目，不直接写库——模型把周三看成周二
 * 在人眼下一秒就能发现，落进日历后要查一学期。
 */

import { LlmError, visionChat } from '../ai/llm'
import { isReady, loadSettings, resolveVision, type LlmSettings } from '../ai/settings'
import { parseTimetable } from './parse'

/**
 * 超过这个边长就缩一缩，省 token 也省时间。
 * 教务系统的课表截图字很小、格子很密，缩到 1600 常常糊成一片，
 * 模型只能回一句「看不清」，所以放宽到 2200。
 */
const MAX_SIDE = 2200

const TIMETABLE_PROMPT = `这是一张课程表的截图。请把它读成纯文本表格，直接输出，不要任何解释、不要代码块标记。

输出规则：
1. 每行一门课，六个字段用 Tab 分隔，顺序固定为：课程名称、星期、节次、周次、地点、教师。
2. 第一行的表头就写：课程名称\t星期\t节次\t周次\t地点\t教师
3. 星期写「周一」到「周日」；节次写「1-2」这种，只上一节就写「3」；周次写「1-16」「3-8」「1-15单」这种；看不清的字段留空。
4. 同一门课在一周里上多次、或分单双周上，各占一行，不要合并。
5. 如果图片里有「第一周」「开学」对应的日期，在第一行前面加一行：# 第一周 2026-09-07（日期换成图上那个）。
6. 如果这张图不是课程表，只输出一行：NOT_TIMETABLE。
7. 只要图里能看出课程格子就照实输出，字段看不清就留空，**不要**写「看不清」「无法识别」这类话代替数据行。`


/** 图片转成 data URL，顺手压一下体积。 */
export async function fileToDataUrl(file: File, maxSide = MAX_SIDE): Promise<string> {
  const source = await loadBitmap(file)
  const width0 = 'naturalWidth' in source && source.naturalWidth ? source.naturalWidth : source.width
  const height0 = 'naturalHeight' in source && source.naturalHeight ? source.naturalHeight : source.height
  const scale = Math.min(1, maxSide / Math.max(width0, height0))
  const width = Math.max(1, Math.round(width0 * scale))
  const height = Math.max(1, Math.round(height0 * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器不支持画布，换一张图或换个浏览器试试。')
  // PNG 透明区转 JPEG 会变黑，先铺白底。
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(source, 0, 0, width, height)
  if ('close' in source && typeof source.close === 'function') source.close()

  return canvas.toDataURL('image/jpeg', 0.86)
}

/**
 * 解码图片。
 *
 * 两条路都走：先 <img>（兼容性最好），不行再 createImageBitmap（快）。
 * 两条都套了超时——个别环境里解码会一直挂着不返回，
 * 与其让界面转圈，不如早点报一句人话。
 */
async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  const error = () => new Error('这张图读不出来，换成 PNG / JPG 再试一次。')
  try {
    return await withTimeout(decodeByImage(file), 8000)
  } catch {
    try {
      return await withTimeout(decodeByBitmap(file), 8000)
    } catch {
      throw error()
    }
  }
}

function decodeByImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    const done = () => URL.revokeObjectURL(url)
    image.onload = () => {
      done()
      resolve(image)
    }
    image.onerror = () => {
      done()
      reject(new Error('decode failed'))
    }
    image.src = url
  })
}

async function decodeByBitmap(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') throw new Error('no createImageBitmap')
  return createImageBitmap(file)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        window.clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * 把模型吐回来的文本整理成解析器吃得下的样子。
 *
 * 模型爱加 ``` 围栏、爱用 Markdown 表格、爱在开头写「以下是课程表」，
 * 这里都清掉；清完的行再交给 parse.ts 判对错，认不出的照样进 failed。
 */
export function normalizeVisionText(raw: string): string {
  let text = raw.replace(/\r/g, '').trim()
  text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '')

  const lines: string[] = []
  for (const line of text.split('\n')) {
    let value = line.trim()
    if (!value) continue
    // 模型偶尔把整段包在 ``` 里，开头那层上面已经削过，行内的围栏也得当空行跳过。
    if (/^`{3,}/.test(value)) continue

    // Markdown 表格：| 高等数学 | 周一 | 1-2 | ... |
    if (value.startsWith('|')) {
      value = value.replace(/^\|/, '').replace(/\|$/, '')
      if (/^[-\s|:]+$/.test(value)) continue
      value = value
        .split('|')
        .map((cell) => cell.trim())
        .join('\t')
    } else {
      // 没用 Tab 的话按两个以上空格切，单个空格可能是课程名里的间隔。
      if (!value.includes('\t')) value = value.replace(/\s{2,}/g, '\t')
    }

    // 开场白、结尾备注这类整句，不可能是数据行。
    if (/^(以下是|下面是|好的|这是|说明|备注|注意)/.test(value)) continue
    lines.push(value)
  }

  // 注释行（模型从图上读到的开学日）放最前面，表头紧随其后，解析器靠表头认列。
  const comments = lines.filter((line) => line.startsWith('#'))
  const body = lines.filter((line) => !line.startsWith('#'))
  const first = body.findIndex((line) => line.includes('课程') || line.includes('节次'))
  if (first > 0) body.unshift(body.splice(first, 1)[0])

  return [...comments, ...body].join('\n')
}

export interface OcrResult {
  text: string
  /** 给界面显示的一句话，比如识别了几行。 */
  note: string
  /** 一条课都没读出来时为 true，调用方别把空结果当成成功。 */
  empty: boolean
  /** 模型原话，只在读失败时用来排查（截断过）。 */
  raw: string
}

/** 把模型原话压成一行，用作错误提示里的证据。 */
function excerpt(raw: string, limit = 160): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}

/** OCR 约定的列顺序，模型漏写表头时补上。 */
const OCR_COLUMNS = '课程名称\t星期\t节次\t周次\t地点\t教师'

/**
 * 模型偶尔只给数据行、不给表头。
 *
 * 没有表头时解析器会退回「自由文本」模式，而那个模式要求节次带「节」字
 * （不然「1-16周」会被当成第 1–16 节），于是整批行都判成「没认岀第几节」。
 * 列顺序是 prompt 里定死的，直接补一行表头即可，只对 OCR 结果做，不动用户手贴的文本。
 */
function withHeaderIfMissing(text: string): string {
  const rows = text.split('\n').filter((line) => line.trim() && !line.startsWith('#'))
  if (rows.length === 0) return text
  const everyRowTabular = rows.every((line) => line.split('\t').length >= 4)
  const hasHeader = rows.some((line) => /课程|节次/.test(line))
  if (!everyRowTabular || hasHeader) return text
  return `${OCR_COLUMNS}\n${text}`
}

/** 把已经是 data URL 的图再缩一档。图越小，推理型模型花在「看图思考」上的预算越少。 */
async function shrinkDataUrl(dataUrl: string, maxSide: number): Promise<string> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error('缩图失败，换个浏览器试试。'))
    element.src = dataUrl
  })
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
  if (scale >= 1) return dataUrl
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const context = canvas.getContext('2d')
  if (!context) return dataUrl
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.82)
}

/** 调视觉模型读课表。settings 不传就读用户当前的配置。 */
export async function recognizeTimetable(
  dataUrl: string,
  settings: LlmSettings = loadSettings(),
): Promise<OcrResult> {
  const vision = resolveVision(settings)
  if (!isReady(vision)) {
    throw new Error('还没配好模型。到设置页填上 API Key，识图模型填一个带视觉的型号（如 deepseek-flash）。')
  }

  // 一份课表能到十几门课、每门一行六字段，预算给小了会被截断；而推理型视觉模型
  // 会把预算先花在「思考」上（实测有 8000 token 全用来思考、一个字没吐的），
  // 所以按「加预算 → 再把图缩小」的顺序试三档，别让用户自己猜。
  const plans: { tokens: number; side: number }[] = [
    { tokens: 4096, side: 0 },
    { tokens: 8192, side: 0 },
    { tokens: 8192, side: 1400 },
  ]

  let raw = ''
  let lastError: unknown = null
  for (const plan of plans) {
    const source = plan.side > 0 ? await shrinkDataUrl(dataUrl, plan.side) : dataUrl
    try {
      raw = await visionChat(vision, {
        prompt: TIMETABLE_PROMPT,
        images: [source],
        temperature: 0,
        maxTokens: plan.tokens,
      })
      break
    } catch (error) {
      // 只有「被截断」值得换一档重试；网络、鉴权、不收图之类的错误重试也没用。
      if (error instanceof LlmError && error.code === 'truncated') {
        lastError = error
        continue
      }
      throw error
    }
  }

  if (!raw) throw lastError ?? new Error('识图没有返回内容。')

  if (/NOT_TIMETABLE/.test(raw)) {
    return {
      text: '',
      note: '模型说这张图不是课程表。换一张完整的课表截图试试。',
      empty: true,
      raw: excerpt(raw),
    }
  }

  // 空返回理论上已经在 visionChat 里拦掉了，这里兜一下自定义网关不按套路返回的情况。
  if (!raw.trim()) {
    throw new Error(
      '模型返回了空内容。常见原因是当前识图模型不收图片，或者输出被长度限制截断了。' +
        '到设置页确认「识图模型」填的是带视觉的型号，比如 deepseek-flash。',
    )
  }

  let text = normalizeVisionText(raw)
  // 直接交给解析器数门课，别用「行数 - 1」估：模型可能不写表头（少算一门），
  // 也可能塞进一行乱码（多算一门）。解析器认出来的才算数。
  let parsed = parseTimetable(text, 20)
  if (parsed.items.length === 0) {
    const patched = withHeaderIfMissing(text)
    if (patched !== text) {
      text = patched
      parsed = parseTimetable(text, 20)
    }
  }

  if (parsed.items.length === 0) {
    const firstFail = parsed.failed[0]
    const detail = firstFail ? `；第一行的问题是「${firstFail.reason}」` : ''
    return {
      text: '',
      // 把模型原话带出来，否则用户只会看到一句「没读出内容」，不知道到底哪儿不对。
      note: excerpt(raw)
        ? `没读出课程行。模型回的是：「${excerpt(raw)}」${detail}。多半是图太小或字太密，换一张更清楚的截图再试。`
        : '没读出内容，检查图片是不是完整课表。',
      empty: true,
      raw: excerpt(raw),
    }
  }

  return {
    text,
    note:
      `读了 ${parsed.items.length} 门课` +
      (parsed.failed.length > 0 ? `，${parsed.failed.length} 行没认出来` : '') +
      '，已填进下方，逐行核对后再导入。',
    empty: false,
    raw: '',
  }
}
