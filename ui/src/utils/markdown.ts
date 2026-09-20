import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  html: false, // 禁止原始 HTML，模型输出不可信
  linkify: true,
  breaks: true,
})

/** 渲染模型回复为 HTML（配合 .md-body 样式使用） */
export function renderMarkdown(text: string): string {
  if (!text) return ''
  return md.render(text)
}
