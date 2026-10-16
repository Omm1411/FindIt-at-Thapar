import React from "react";
import { supabase } from "./lib/supabase.js";
import { useEffect, useMemo, useState } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";
const categories = ["Electronics", "ID Cards", "Books & Stationery", "Accessories", "Clothing", "Other"];

function App() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [listingView, setListingView] = useState("all");
  const [myItemIds, setMyItemIds] = useState(() => new Set());
  const [showForm, setShowForm] = useState(false);
  const [editingItemId, setEditingItemId] = useState(null);
  const [editForm, setEditForm] = useState({ title: "", type: "lost", category: "Electronics", location: "", date: "", description: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });
  
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
  
    return () => subscription.unsubscribe();
  }, []);
  async function handleAuth(event) {
    event.preventDefault();
    setAuthMessage("");
  
    const result =
      authMode === "signup"
        ? await supabase.auth.signUp({
            email: authEmail,
            password: authPassword,
          })
        : await supabase.auth.signInWithPassword({
            email: authEmail,
            password: authPassword,
          });
  
    if (result.error) {
      setAuthMessage(result.error.message);
      return;
    }
  
    if (authMode === "signup" && !result.data.session) {
      setAuthMessage("Check your email to confirm your account.");
    } else {
      setAuthMessage("Authentication successful.");
    }
  }
  
  async function handleLogout() {
    const { error } = await supabase.auth.signOut();
    if (error) setAuthMessage(error.message);
  }
  const [form, setForm] = useState({
    title: "", type: "lost", category: "Electronics", location: "",
    date: new Date().toISOString().slice(0, 10), description: ""
  });

  async function loadItems() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API}/api/items`);
      if (!response.ok) throw new Error("Could not load listings.");
      const data = await response.json();
      setItems(data);
    } catch {
      setError("Can't reach the backend. Check that the API is running on port 4000.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadItems(); }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadMyItems() {
      if (!session?.access_token) {
        setMyItemIds(new Set());
        return;
      }

      try {
        const response = await fetch(`${API}/api/items/mine`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!response.ok) throw new Error("Could not load your listings.");
        const data = await response.json();
        if (!cancelled) setMyItemIds(new Set(data.map((item) => item.id)));
      } catch {
        if (!cancelled) setMyItemIds(new Set());
      }
    }

    loadMyItems();
    return () => { cancelled = true; };
  }, [session]);

  const filtered = useMemo(() => items.filter((item) => {
    const haystack = `${item.title} ${item.description} ${item.category} ${item.location}`.toLowerCase();
    return haystack.includes(query.toLowerCase())
      && (typeFilter === "all" || item.type === typeFilter)
      && (statusFilter === "all" || item.status === statusFilter)
      && (categoryFilter === "all" || item.category === categoryFilter)
      && (listingView !== "mine" || myItemIds.has(item.id));
  }), [items, query, typeFilter, statusFilter, categoryFilter, listingView, myItemIds]);

  
async function submitItem(event) {
  event.preventDefault();
  setError("");
  setNotice("");

  try {
    const response = await fetch(`${API}/api/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(form),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not create listing.");
    }

    setItems((current) => [data, ...current]);
    setMyItemIds((current) => new Set([...current, data.id]));

    setForm({
      title: "",
      type: "lost",
      category: "Electronics",
      location: "",
      date: new Date().toISOString().slice(0, 10),
      description: "",
    });

    setShowForm(false);
    setNotice("Your listing has been posted.");
  } catch (err) {
    setError(err.message || "Could not create listing.");
  }
}

  

  async function resolveItem(id) {
    try {
      const response = await fetch(`${API}/api/items/${id}/resolve`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update listing.");
      setItems((current) => current.map((item) => item.id === id ? data : item));
    } catch (err) {
      setError(err.message);
    }
  }

  function startEditing(item) {
    setEditingItemId(item.id);
    setEditForm({
      title: item.title,
      type: item.type,
      category: item.category,
      location: item.location,
      date: item.date,
      description: item.description,
    });
    setError("");
    setNotice("");
  }

  async function saveEdit(event, id) {
    event.preventDefault();
    setError("");
    setNotice("");

    try {
      const response = await fetch(`${API}/api/items/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(editForm),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update listing.");
      setItems((current) => current.map((item) => item.id === id ? data : item));
      setEditingItemId(null);
      setNotice("Your listing has been updated.");
    } catch (err) {
      setError(err.message || "Could not update listing.");
    }
  }

  async function deleteItem(id) {
    if (!window.confirm("Delete this listing? This cannot be undone.")) return;
    setError("");
    setNotice("");

    try {
      const response = await fetch(`${API}/api/items/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not delete listing.");
      setItems((current) => current.filter((item) => item.id !== id));
      setMyItemIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      if (editingItemId === id) setEditingItemId(null);
      setNotice("Your listing has been deleted.");
    } catch (err) {
      setError(err.message || "Could not delete listing.");
    }
  }

  const openCount = items.filter((item) => item.status === "open").length;
  const foundCount = items.filter((item) => item.type === "found" && item.status === "open").length;

  
return (
  <main className="shell">
    <nav className="nav">
      <a className="brand" href="#">
        <span className="brand-mark">F</span> FindIt
        <span className="brand-at">@Thapar</span>
      </a>

      {session ? (
        <div className="nav-tag">
          <span>{session.user.email}</span>
          <button className="text-button" onClick={handleLogout}>
            Log out
          </button>
        </div>
      ) : (
        <span className="nav-tag">CAMPUS COMMUNITY</span>
      )}
    </nav>

    {authLoading ? (
      <section className="form-panel">
        <p className="empty">Checking your session...</p>
      </section>
    ) : !session ? (
      <>
        <section className="hero">
          <div className="eyebrow">
            <span className="pulse" /> THAPAR LOST & FOUND
          </div>
          <h1>
            Lost something?<br />
            <span>Let's bring it home.</span>
          </h1>
          <p className="hero-copy">
            Sign in to join your campus lost-and-found community.
          </p>
        </section>

        <section className="form-panel auth-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">CAMPUS ACCESS</p>
              <h2>
                {authMode === "login"
                  ? "Welcome back"
                  : "Create your account"}
              </h2>
            </div>
          </div>

          <form className="listing-form" onSubmit={handleAuth}>
            <label>
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>

            <label>
              Password
              <input
                type="password"
                required
                minLength={6}
                autoComplete={
                  authMode === "login"
                    ? "current-password"
                    : "new-password"
                }
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder="At least 6 characters"
              />
            </label>

            <button className="primary-button" type="submit">
              {authMode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>

          {authMessage && (
            <div className="message">{authMessage}</div>
          )}

          <p className="hero-copy">
            {authMode === "login"
              ? "New to FindIt@Thapar?"
              : "Already have an account?"}
            {" "}
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setAuthMode(
                  authMode === "login" ? "signup" : "login"
                );
                setAuthMessage("");
              }}
            >
              {authMode === "login" ? "Sign up" : "Sign in"}
            </button>
          </p>
        </section>
      </>
    ) : (
      <>
        <section className="hero">
          <div className="eyebrow">
            <span className="pulse" /> THAPAR LOST & FOUND
          </div>
          <h1>
            Lost something?<br />
            <span>Let's bring it home.</span>
          </h1>
          <p className="hero-copy">
            One campus. One place to find what went missing.
          </p>

          <button
            className="primary-button"
            onClick={() => {
              setShowForm(!showForm);
              setNotice("");
            }}
          >
            {showForm ? "Close form" : "+ Post a listing"}
          </button>

          <div className="stats">
            <div>
              <strong>{openCount}</strong>
              <span>Open listings</span>
            </div>
            <div>
              <strong>{foundCount}</strong>
              <span>Items found</span>
            </div>
            <div>
              <strong>1</strong>
              <span>Campus community</span>
            </div>
          </div>
        </section>

        {showForm && (
          <section className="form-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">HELP THE COMMUNITY</p>
                <h2>Post an item</h2>
              </div>
            </div>

            <form onSubmit={submitItem} className="listing-form">
              <label>
                Listing title
                <input
                  required
                  maxLength="100"
                  value={form.title}
                  onChange={(e) =>
                    setForm({ ...form, title: e.target.value })
                  }
                  placeholder="e.g. Black calculator"
                />
              </label>

              <div className="form-grid">
                <label>
                  I'm reporting a
                  <select
                    value={form.type}
                    onChange={(e) =>
                      setForm({ ...form, type: e.target.value })
                    }
                  >
                    <option value="lost">Lost item</option>
                    <option value="found">Found item</option>
                  </select>
                </label>

                <label>
                  Category
                  <select
                    value={form.category}
                    onChange={(e) =>
                      setForm({ ...form, category: e.target.value })
                    }
                  >
                    {categories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>

                <label>
                  Location
                  <input
                    required
                    value={form.location}
                    onChange={(e) =>
                      setForm({ ...form, location: e.target.value })
                    }
                    placeholder="e.g. Library, J hostel"
                  />
                </label>

                <label>
                  Date
                  <input
                    required
                    type="date"
                    value={form.date}
                    onChange={(e) =>
                      setForm({ ...form, date: e.target.value })
                    }
                  />
                </label>
              </div>

              <label>
                Description
                <textarea
                  required
                  maxLength="1000"
                  rows="3"
                  value={form.description}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      description: e.target.value,
                    })
                  }
                  placeholder="Describe the item without sharing sensitive personal details."
                />
              </label>

              <button className="primary-button" type="submit">
                Publish listing
              </button>
            </form>
          </section>
        )}

        <section className="listings">
          <div className="section-heading">
            <div>
              <p className="eyebrow">THE CAMPUS BOARD</p>
              <h2>Recent listings</h2>
            </div>
            <span className="result-count">
              {filtered.length} LISTINGS
            </span>
          </div>

          <div className="toolbar">
            <select
              aria-label="Choose listing view"
              value={listingView}
              onChange={(e) => setListingView(e.target.value)}
            >
              <option value="all">Campus board</option>
              <option value="mine">My listings</option>
            </select>

            <div className="searchbox">
              <span>⌕</span>
              <input
                aria-label="Search listings"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search items, places, keywords..."
              />
            </div>

            <select
              aria-label="Filter by type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="all">All types</option>
              <option value="lost">Lost</option>
              <option value="found">Found</option>
            </select>

            <select
              aria-label="Filter by category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="all">All categories</option>
              {categories.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>

            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
              <option value="all">All statuses</option>
            </select>
          </div>

          {error && <div className="message error">{error}</div>}
          {notice && <div className="message success">{notice}</div>}

          {loading ? (
            <p className="empty">Loading listings...</p>
          ) : filtered.length === 0 ? (
            <div className="empty">
              <span>◎</span>
              <h3>No listings found</h3>
              <p>Try another search or post a new listing.</p>
            </div>
          ) : (
            <div className="card-grid">
              {filtered.map((item) => (
                <article className="item-card" key={item.id}>
                  <div className="card-top">
                    <span className={`type-pill ${item.type}`}>
                      {item.type === "lost"
                        ? "LOST ITEM"
                        : "FOUND ITEM"}
                    </span>
                    <span className={`status-dot ${item.status}`}>
                      {item.status === "open"
                        ? "● Open"
                        : "✓ Resolved"}
                    </span>
                  </div>

                  {editingItemId === item.id ? (
                    <form className="listing-form" onSubmit={(event) => saveEdit(event, item.id)}>
                      <label>Title
                        <input required maxLength="120" value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} />
                      </label>
                      <div className="form-grid">
                        <label>Type
                          <select value={editForm.type} onChange={(e) => setEditForm({ ...editForm, type: e.target.value })}>
                            <option value="lost">Lost item</option><option value="found">Found item</option>
                          </select>
                        </label>
                        <label>Category
                          <select value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })}>
                            {categories.map((category) => <option key={category}>{category}</option>)}
                          </select>
                        </label>
                        <label>Location
                          <input required maxLength="120" value={editForm.location} onChange={(e) => setEditForm({ ...editForm, location: e.target.value })} />
                        </label>
                        <label>Date
                          <input required type="date" value={editForm.date} onChange={(e) => setEditForm({ ...editForm, date: e.target.value })} />
                        </label>
                      </div>
                      <label>Description
                        <textarea required maxLength="1000" rows="3" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
                      </label>
                      <button className="primary-button" type="submit">Save changes</button>
                      <button className="text-button" type="button" onClick={() => setEditingItemId(null)}>Cancel</button>
                    </form>
                  ) : (
                    <>
                      <h3>{item.title}</h3>
                      <p className="description">{item.description}</p>
                    </>
                  )}

                  <div className="meta">
                    <span>⌖ {item.location}</span>
                    <span>▦ {item.category}</span>
                    <span>◷ {item.date}</span>
                  </div>

                  {myItemIds.has(item.id) && (
                    <div className="owner-actions">
                      {item.status === "open" && (
                        <button className="text-button" onClick={() => resolveItem(item.id)}>
                          Mark resolved ↗
                        </button>
                      )}
                      {editingItemId !== item.id && (
                        <button className="text-button" onClick={() => startEditing(item)}>Edit</button>
                      )}
                      <button className="text-button" onClick={() => deleteItem(item.id)}>Delete</button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </>
    )}

    <section className="creator-section" id="about-creator" aria-labelledby="creator-title">
      <div className="creator-copy">
        <p className="eyebrow">THE PERSON BEHIND THE PROJECT</p>
        <h2 id="creator-title">Built by <span>Mrytyunjay.</span></h2>
        <p>
          I created FindIt@Thapar to make it easier for the Thapar community
          to report lost belongings, share found items, and help them find their way home.
        </p>
      </div>
      <div className="creator-stamp" aria-hidden="true">
        <span>F</span>
        <small>MADE FOR THAPAR</small>
      </div>
    </section>

    <footer>
      <span>FindIt@Thapar</span>
      <span>Built for a more helpful campus.</span>
    </footer>
  </main>
);
}
export default App;
