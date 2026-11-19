export function normalizeProductImageUrl(value, imageDirectory) {
  const imagePath = String(value || '').trim()
  if (!imagePath) return ''

  const legacyDriveUrl = imagePath.match(/^imgp:\/\/([a-z]):\/(.*)$/i)
  if (legacyDriveUrl) {
    return `imgp:///${legacyDriveUrl[1].toUpperCase()}:/${legacyDriveUrl[2]}`
  }

  const legacyRelativeImage = imagePath.match(/^imgp:\/\/\.\.\/img\/(.+)$/)
  const directory = String(imageDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (legacyRelativeImage && /^[a-z]:\//i.test(directory)) {
    if (imagePath.includes('productDir=')) return imagePath
    const separator = imagePath.includes('?') ? '&' : '?'
    return `${imagePath}${separator}productDir=${encodeURIComponent(directory)}`
  }

  if (imagePath.startsWith('imgp://')) return imagePath

  const normalizedPath = imagePath.replace(/\\/g, '/')
  if (/^[a-z]:\//i.test(normalizedPath)) {
    return `imgp:///${normalizedPath}`
  }

  return `imgp://${normalizedPath}`
}

export function productImagePathFromRequest(hostname, pathname) {
  const requestPath = decodeURIComponent(pathname)
  const absoluteMatch = requestPath.match(/^\/([a-z]:\/.*)$/i)
  if (absoluteMatch) return absoluteMatch[1]

  const driveHost = String(hostname || '').match(/^([a-z])$/i)
  return driveHost ? `${driveHost[1].toUpperCase()}:${requestPath}` : null
}
