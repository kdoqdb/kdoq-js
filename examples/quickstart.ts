// Needs a running kdoq server; not run by `bun test`.
import { connect, ErrorCode, KdoqError } from "../src";

// A type alias, not an interface: `collection<T>` needs T assignable to `Doc`.
type Account = {
  name: string;
  age: number;
};

await using client = await connect("kdoq://user:pass@localhost:27505/app");
const accounts = client.db().collection<Account>("accounts");

await accounts.put("u1", { name: "Ann", age: 31 });

for await (const { key, value } of accounts.find("age >= 30")) {
  console.log(key, value.name);
}

try {
  await accounts.get("missing");
} catch (error) {
  if (!(error instanceof KdoqError) || error.code !== ErrorCode.NotFound) throw error;
}
