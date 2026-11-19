
//该文件未使用
import { JSONFilePreset } from 'lowdb/node'

// const STORE_PATH = app.getPath('userData') // 获取electron应用的用户目录
// if (!fs.pathExistsSync(STORE_PATH)) { // 如果不存在路径
//     fs.mkdirpSync(STORE_PATH) // 就创建
//   }
// const adapter = new FileSync(path.join(STORE_PATH, '/data.json')) // 初始化lowdb读写的json文件名以及存储路径

// const db = Datastore(adapter) // lowdb接管该文件

// if (!db.has('data').value()) { // 先判断该值存不存在
//     db.set('data', []).write() // 不存在就创建
//   }

const db = await JSONFilePreset('db.json', { posts: [] })

export default db // 暴露出去

