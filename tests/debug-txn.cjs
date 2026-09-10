const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

(async () => {
  const m = await MongoMemoryServer.create({
    instance: { args: ["--replSet", "rs0"] },
  });
  const uri = m.getUri();
  const port = new URL(uri).port;
  console.log("uri", uri);

  const direct = new MongoClient(uri, { directConnection: true });
  await direct.connect();
  await direct.db("admin").command({
    replSetInitiate: {
      _id: "rs0",
      members: [{ _id: 0, host: `127.0.0.1:${port}` }],
    },
  });
  await direct.close();

  let primary = false;
  for (let i = 0; i < 30 && !primary; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const probe = new MongoClient(uri, { directConnection: true });
    await probe.connect();
    const hello = await probe.db("admin").command({ hello: 1 });
    await probe.close();
    primary = hello.isWritablePrimary;
  }
  console.log("primary:", primary);

  const c = new MongoClient(uri);
  await c.connect();
  const s = c.startSession();
  await s.withTransaction(async () => {
    await c.db("t").collection("x").insertOne({ a: 1 }, { session: s });
  });
  console.log(
    "txn OK, count:",
    await c.db("t").collection("x").countDocuments(),
  );
  await s.endSession();
  await c.close();
  await m.stop();
})();
