let wallet = null;
let connection = null;

function setWallet(w) {
    wallet = w;
}

function setConnection(c) {
    connection = c;
}

function getWallet() {
    return wallet;
}

function getConnection() {
    return connection;
}

module.exports = {
    setWallet,
    setConnection,
    getWallet,
    getConnection
};