import { MongoMemoryServer } from "mongodb-memory-server";
import { existsSync } from "fs";

const localBin = "C:\\Program Files\\MongoDB\\Server\\8.3\\bin\\mongod.exe";
console.log("exists:", existsSync(localBin));

const mongod = await MongoMemoryServer.create({
  binary: { systemBinary: localBin },
  replicaSet: "rs0",
  instance: { storageEngine: "wiredTiger" },
});
console.log("uri:", mongod.getUri());
const client = new (await import("mongodb")).MongoClient(mongod.getUri());
await client.connect();
console.log("hello:", JSON.stringify(await client.db("admin").command({ hello: 1 })));
await client.close();
await mongod.stop();
