var NeDB = require('nedb')
var path = require('path')

var db = null

function initializeDatabase(dataDirectory) {
    if (db) throw new Error('Database has already been initialized')
    db = new NeDB({
        filename: path.join(dataDirectory, 'user.db'),
        autoload: true,
    })
    return db
}

function getDatabase() {
    if (!db) throw new Error('Database has not been initialized')
    return db
}

function insert(data) {
    getDatabase().insert(data, function(err, doc) {
        console.log('inserted:', doc)
    })
}

function getAll(){
    return getDatabase().getAllData()
}

function getProductByName(searchName){
    console.log(searchName)
    getDatabase().find({"$or":[{product_name: new RegExp(searchName, 'i')}, {product_content: new RegExp(searchName, 'i')}] }, (err, docs) => {
        if (err) {
            console.error('Error executing query:', err);
            return;
          }
        return docs
    });
}

export {db, initializeDatabase, getAll, getProductByName}