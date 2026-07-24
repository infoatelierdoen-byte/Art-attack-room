export default function Home() {
  return (
    <div style={{ padding: 40, color: "#F4F1EC" }}>
      <h1>Art Attack Room — boekingssysteem (MVP)</h1>
      <p>
        <a style={{ color: "var(--accent)" }} href="/widget">Klant-widget</a>
        {" · "}
        <a style={{ color: "var(--accent)" }} href="/widget/cadeaubon">Cadeaubon kopen</a>
        {" · "}
        <a style={{ color: "var(--accent)" }} href="/backend">Back-end</a>
      </p>
    </div>
  );
}
