var NeDB = require('nedb')

var db = new NeDB({
    filename: './userdata/user.db',
    autoload: true,
})


function insert(data) {
    db.insert(data, function(err, doc) {
        console.log('inserted:', doc)
    })
}

function getAll(){
    return db.getAllData()
}

function getProductByName(searchName){
    console.log(searchName)
    db.find({"$or":[{product_name: new RegExp(searchName, 'i')}, {product_content: new RegExp(searchName, 'i')}] }, (err, docs) => {
        if (err) {
            console.error('Error executing query:', err);
            return;
          }
        return docs
    });
}

export   {db, getAll, getProductByName}