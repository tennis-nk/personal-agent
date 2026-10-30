/** 资料的预设分类。数组顺序即界面展示顺序。 */
export const NOTE_CATEGORIES = [
  '工作',
  '学习',
  '生活',
  '灵感',
  '人脉',
  '财务',
  '健康',
  '待归档',
] as const

/** 尚未经过 AI 处理时的占位分类。 */
export const UNCATEGORIZED = '未分类'

/** 预设分类 + 库里已经出现过的自定义分类，去重后按预设顺序再按字母排。 */
export function mergeCategories(used: (string | null | undefined)[]): string[] {
  const extras = Array.from(
    new Set(
      used
        .map((item) => (item ?? '').trim())
        .filter((item) => item.length > 0 && item !== UNCATEGORIZED),
    ),
  ).filter((item) => !(NOTE_CATEGORIES as readonly string[]).includes(item))

  extras.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  return [...NOTE_CATEGORIES, ...extras]
}
