'use strict'

const path = require('path')
const Datastore = require('nedb')

// 全 Datastore の生成をここに集約する。ファイル名・保存先は従来どおり
// （userDataDir 直下）。商品 DB は従来モジュール nedb/db が生成する。
function createDatastores(userDataDir) {
  const database = require('../nedb/db')
  const db = database.initializeDatabase(userDataDir)
  const tasksDb = new Datastore({
    filename: path.join(userDataDir, 'tasks.db'),
    autoload: true,
  })
  const conditionsDb = new Datastore({
    filename: path.join(userDataDir, 'conditions.db'),
    autoload: true,
  })
  const listingsDb = new Datastore({
    filename: path.join(userDataDir, 'listings.db'),
    autoload: true,
  })
  const nodesDb = new Datastore({
    filename: path.join(userDataDir, 'nodes.db'),
    autoload: true,
  })
  return { db, getAll: database.getAll, tasksDb, conditionsDb, listingsDb, nodesDb }
}

module.exports = { createDatastores }
