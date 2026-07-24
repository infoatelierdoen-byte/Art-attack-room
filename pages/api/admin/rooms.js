const store = require("../../../lib/store-sql");

// GET /api/admin/rooms — lijst van rooms (code + capaciteit), voor het
// room-sluiten-scherm in /backend.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const rooms = await store.getRoomsList();
  res.status(200).json({ rooms });
}
