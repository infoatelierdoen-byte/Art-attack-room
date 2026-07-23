const store = require("../../lib/store-sql");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.status(200).json({ services: await store.getServices() });
}
