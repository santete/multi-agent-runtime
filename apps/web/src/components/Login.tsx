import type { ActorDto } from "@mar/core";
import { useState } from "react";
import { api, setToken } from "../lib/api.js";

export function Login({ onLogin }: { onLogin: (actor: ActorDto) => void }) {
  const [token, setValue] = useState("");
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setToken(token.trim());
    try {
      const actor = await api.me();
      if (actor.role === "runner") throw new Error("runner tokens cannot use the dashboard");
      onLogin(actor);
    } catch (err) {
      setToken(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="login">
      <form onSubmit={submit} className="card">
        <h1>
          <span className="brand-mark">◆</span> Multi-Agent Runtime
        </h1>
        <p className="muted">Sign in with your API token.</p>
        <input
          type="password"
          autoFocus
          placeholder="API token"
          value={token}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={!token.trim()}>
          Sign in
        </button>
      </form>
    </div>
  );
}
