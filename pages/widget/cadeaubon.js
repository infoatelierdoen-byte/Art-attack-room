import { useState } from "react";

const PRESET_AMOUNTS = [25, 50, 75, 100];

export default function CadeaubonKopen() {
  const [amount, setAmount] = useState(50);
  const [customAmount, setCustomAmount] = useState("");
  const [form, setForm] = useState({ name: "", email: "", note: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const effectiveAmount = customAmount ? Number(customAmount) : amount;

  async function submit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/gift-cards/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: effectiveAmount,
          purchaser: { name: form.name, email: form.email, note: form.note }
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Er ging iets mis.");
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div style={styles.wrap}>
        <div style={styles.card}>
          <h2 style={{ color: "var(--accent)" }}>Bijna klaar!</h2>
          <p>Rond de betaling af — je ontvangt de cadeaubon-code meteen per e-mail.</p>
          {result.mocked && (
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              (Dev-modus: er is geen echte Mollie-key ingesteld, dit is een mock-checkout-link.)
            </p>
          )}
          <a href={result.checkoutUrl} style={styles.primaryBtn}>Naar betaling</a>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.h1}>Cadeaubon kopen</h1>
        <p style={styles.note}>
          Bruikbaar voor al onze workshops, 1 jaar geldig.
        </p>

        <div style={styles.presetRow}>
          {PRESET_AMOUNTS.map(a => (
            <button
              key={a}
              type="button"
              onClick={() => { setAmount(a); setCustomAmount(""); }}
              style={{
                ...styles.presetBtn,
                ...(!customAmount && amount === a ? styles.presetBtnSelected : {})
              }}
            >
              €{a}
            </button>
          ))}
        </div>
        <input
          placeholder="Ander bedrag (€5 – €500)"
          type="number"
          min="5"
          max="500"
          value={customAmount}
          onChange={e => setCustomAmount(e.target.value)}
          style={styles.input}
        />

        <form onSubmit={submit} style={{ marginTop: 12 }}>
          <input required placeholder="Jouw naam" value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })} style={styles.input} />
          <input required type="email" placeholder="Jouw e-mail" value={form.email}
            onChange={e => setForm({ ...form, email: e.target.value })} style={styles.input} />
          <textarea placeholder="Boodschap voor de ontvanger (optioneel)" value={form.note}
            onChange={e => setForm({ ...form, note: e.target.value })} style={{ ...styles.input, minHeight: 60 }} />

          {error && <p style={{ color: "#FF8A8A" }}>{error}</p>}

          <button type="submit" disabled={submitting || !effectiveAmount} style={styles.primaryBtn}>
            {submitting ? "Bezig…" : `Bevestig en betaal — €${effectiveAmount || 0}`}
          </button>
        </form>

        <p style={{ ...styles.note, marginTop: 16 }}>
          <a href="/widget" style={{ color: "var(--accent)" }}>← Terug naar boeken</a>
        </p>
      </div>
    </div>
  );
}

const styles = {
  wrap: { minHeight: "100vh", display: "flex", justifyContent: "center", padding: "24px 12px" },
  card: { width: "100%", maxWidth: 480, background: "var(--panel)", borderRadius: 16, padding: 24 },
  h1: { fontSize: 22, marginTop: 0 },
  note: { color: "var(--muted)", fontSize: 13 },
  presetRow: { display: "flex", gap: 8, marginBottom: 10 },
  presetBtn: { flex: 1, padding: "10px 0", borderRadius: 10, border: "1px solid var(--line)", background: "transparent", color: "var(--text)" },
  presetBtnSelected: { background: "var(--accent)", borderColor: "var(--accent)", fontWeight: 700 },
  input: { display: "block", width: "100%", marginBottom: 10, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "#1C1C1F", color: "var(--text)" },
  primaryBtn: { display: "inline-block", width: "100%", textAlign: "center", padding: "12px 16px", borderRadius: 10, border: "none", background: "var(--accent)", color: "#fff", fontWeight: 700, textDecoration: "none", cursor: "pointer" }
};
