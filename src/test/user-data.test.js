const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {prepareUserDataDirectory} = require('../utils/user-data')

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selling-goods-manager-data-'))
  try {
    const legacyRoot = path.join(root, 'legacy')
    const appDataPath = path.join(root, 'app-data')
    fs.mkdirSync(path.join(legacyRoot, 'userdata'), {recursive: true})
    fs.mkdirSync(path.join(legacyRoot, 'img'), {recursive: true})
    fs.writeFileSync(path.join(legacyRoot, 'userdata', 'user.db'), 'user database')
    fs.writeFileSync(path.join(legacyRoot, 'userdata', 'manager.json'), '{"token":"local"}')
    fs.writeFileSync(path.join(legacyRoot, 'img', 'main.jpg'), 'image')

    const result = await prepareUserDataDirectory(appDataPath, legacyRoot)
    assert.strictEqual(result.migrated, true)
    assert.strictEqual(fs.readFileSync(path.join(result.dataDirectory, 'user.db'), 'utf8'), 'user database')
    assert.strictEqual(fs.readFileSync(path.join(result.dataDirectory, 'manager.json'), 'utf8'), '{"token":"local"}')
    assert.strictEqual(fs.readFileSync(path.join(result.imageDirectory, 'main.jpg'), 'utf8'), 'image')
    assert.strictEqual(fs.existsSync(path.join(legacyRoot, 'userdata', 'user.db')), true)

    fs.writeFileSync(path.join(legacyRoot, 'userdata', 'user.db'), 'new legacy data')
    const secondRun = await prepareUserDataDirectory(appDataPath, legacyRoot)
    assert.strictEqual(secondRun.migrated, false)
    assert.strictEqual(fs.readFileSync(path.join(result.dataDirectory, 'user.db'), 'utf8'), 'user database')

    const conflictRoot = path.join(root, 'conflict')
    const conflictLegacyRoot = path.join(conflictRoot, 'legacy')
    const conflictAppDataPath = path.join(conflictRoot, 'app-data')
    fs.mkdirSync(path.join(conflictLegacyRoot, 'userdata'), {recursive: true})
    fs.mkdirSync(path.join(conflictAppDataPath, 'userdata'), {recursive: true})
    fs.writeFileSync(path.join(conflictLegacyRoot, 'userdata', 'user.db'), 'legacy')
    fs.writeFileSync(path.join(conflictAppDataPath, 'userdata', 'user.db'), 'current')
    await assert.rejects(
      prepareUserDataDirectory(conflictAppDataPath, conflictLegacyRoot),
      /both exist/
    )
    assert.strictEqual(
      fs.readFileSync(path.join(conflictAppDataPath, 'userdata', 'user.db'), 'utf8'),
      'current'
    )
  } finally {
    fs.rmSync(root, {recursive: true, force: true})
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
