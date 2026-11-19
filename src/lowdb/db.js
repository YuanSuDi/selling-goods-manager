import db from './datastore';
//未使用

 function insert (data){
     db.update(({ posts }) => posts.push(data))
}



export default insert