const fs = require('fs')
const path = require('path')

const MIGRATION_MARKER = '.storage-migration-v1'

function getDirectoryEntries(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, {withFileTypes: true})
    .filter((entry) => entry.isFile() || entry.isDirectory())
}

async function copyDirectoryContents(source, destination) {
  await fs.promises.mkdir(destination, {recursive: true})
  const entries = await fs.promises.readdir(source, {withFileTypes: true})
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, destinationPath)
    } else if (entry.isFile()) {
      await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL)
    }
  }
}

async function prepareUserDataDirectory(userDataPath, legacyRoot) {
  const applicationDataPath = path.resolve(userDataPath)
  const legacyPath = path.resolve(legacyRoot)
  const dataDirectory = path.join(applicationDataPath, 'userdata')
  const imageDirectory = path.join(dataDirectory, 'img')
  const markerPath = path.join(applicationDataPath, MIGRATION_MARKER)

  await fs.promises.mkdir(dataDirectory, {recursive: true})
  if (fs.existsSync(markerPath)) {
    return {dataDirectory, imageDirectory, migrated: false}
  }

  const legacyDataDirectory = path.join(legacyPath, 'userdata')
  const legacyImageDirectory = path.join(legacyPath, 'img')
  const sameDataDirectory = path.resolve(legacyDataDirectory) === path.resolve(dataDirectory)
  const sameImageDirectory = path.resolve(legacyImageDirectory) === path.resolve(imageDirectory)
  const legacyDataEntries = sameDataDirectory ? [] : getDirectoryEntries(legacyDataDirectory)
  const legacyImageEntries = sameImageDirectory ? [] : getDirectoryEntries(legacyImageDirectory)
  const nestedImageEntries = getDirectoryEntries(path.join(legacyDataDirectory, 'img'))
  const existingDataEntries = getDirectoryEntries(dataDirectory)
    .filter((entry) => entry.name !== 'img')
  const existingImageEntries = getDirectoryEntries(imageDirectory)

  if (legacyDataEntries.length && existingDataEntries.length) {
    throw new Error('Legacy and new user databases both exist; refusing to overwrite either copy.')
  }
  if ((legacyImageEntries.length || nestedImageEntries.length) && existingImageEntries.length) {
    throw new Error('Legacy and new image folders both contain files; refusing to overwrite either copy.')
  }
  if (legacyImageEntries.length && nestedImageEntries.length) {
    throw new Error('Multiple legacy image folders contain files; refusing to merge them automatically.')
  }

  if (legacyDataEntries.length) {
    await copyDirectoryContents(legacyDataDirectory, dataDirectory)
  }
  if (legacyImageEntries.length) {
    await copyDirectoryContents(legacyImageDirectory, imageDirectory)
  }

  await fs.promises.writeFile(markerPath, '1', 'utf8')
  return {
    dataDirectory,
    imageDirectory,
    migrated: legacyDataEntries.length > 0 || legacyImageEntries.length > 0,
  }
}

module.exports = {prepareUserDataDirectory}
