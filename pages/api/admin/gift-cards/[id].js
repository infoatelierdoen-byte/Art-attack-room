const store = require("../../../../lib/store-sql");
const { requireStaff } = require("../../../../lib/auth");

// PATCH /api/admin/gift-cards/:id — activeren/uitschakelen
// body: { status: "active" | "disabled" }
export default async function handler(req, res) {
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // Enkel Admin — uitschakelen neemt een klant zijn tegoed af, en heractiveren
  // kan een opgebruikte bon weer inzetbaar maken. Zie gift-cards.js.
  const session = requireStaff(req, res);
  if (!session) return;
  if (session.role !== "admin") {
    return res.status(403).json({ error: "Enkel toegankelijk voor Admin." });
  }

  try {
    const { id } = req.query;
    const { status } = req.body;
    const card = await store.setGiftCardStatus(id, status);
    res.status(200).json({ card });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
