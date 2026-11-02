window.__ModuleLoader__.load({
  id: 'dsh-image-iterate-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function attachmentFrom(meta) {
      if (typeof meta !== 'object' || meta === null) return undefined
      const image = meta.image
      if (typeof image !== 'object' || image === null) return undefined
      if (typeof image.attachment_id !== 'string' || typeof image.media_type !== 'string') return undefined
      if (!Number.isInteger(image.bytes) || !Number.isInteger(image.width) || !Number.isInteger(image.height)) return undefined
      return {
        attachmentId: image.attachment_id,
        mediaType: image.media_type,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        ...(typeof image.name === 'string' ? { name: image.name } : {}),
      }
    }

    function textFrom(block) {
      if (!Array.isArray(block.content)) return ''
      return block.content
        .filter(part => typeof part === 'object' && part !== null && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n')
    }

    function ImageResultRow({ phase, block, loadImage }) {
      const attachment = phase === 'result' && !block.isError ? attachmentFrom(block.meta) : undefined
      const text = phase === 'result' ? textFrom(block) : ''
      const [url, setUrl] = React.useState(undefined)
      const [loadError, setLoadError] = React.useState(false)

      React.useEffect(() => {
        let active = true
        setUrl(undefined)
        setLoadError(false)
        if (attachment === undefined) return () => { active = false }
        loadImage(attachment).then(value => {
          if (active) setUrl(value)
        }, () => {
          if (active) setLoadError(true)
        })
        return () => { active = false }
      }, [attachment?.attachmentId, attachment?.mediaType, attachment?.bytes, attachment?.width, attachment?.height, loadImage])

      const children = text === '' ? [] : [h('pre', { key: 'output', style: { margin: 0, whiteSpace: 'pre-wrap' } }, text)]
      if (attachment !== undefined && url !== undefined) {
        children.push(h('img', {
          key: 'image',
          src: url,
          alt: '',
          width: attachment.width,
          height: attachment.height,
          style: { display: 'block', maxWidth: '100%', height: 'auto', marginTop: '8px' },
        }))
      }
      if (attachment !== undefined && loadError) {
        children.push(h('p', { key: 'image-load-error', role: 'status' }, '图片附件暂时无法加载。请重新打开会话或重新发起本次工具调用。'))
      }
      return children.length === 0 ? null : h('div', null, ...children)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'generate_image_with_review',
        }, ImageResultRow))
      },
    }
  },
})
