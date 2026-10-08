export default function App() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, sans-serif",
        background: "#0f172a",
        color: "white",
        textAlign: "center",
        padding: "24px",
      }}
    >
      <h1 style={{ fontSize: "3rem", margin: 0 }}>Jomisu</h1>
      <p style={{ fontSize: "1.2rem", opacity: 0.85 }}>
        What's happening here, right now?
      </p>
      <p style={{ fontSize: "0.9rem", opacity: 0.6 }}>
        Step 1 complete: deployed on Firebase Hosting
      </p>
    </div>
  );
}