import React from "react";
import { supabase } from "./lib/supabase.js";
import { useEffect, useMemo, useState } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";
const categories = ["Electronics", "ID Cards", "Books & Stationery", "Accessories", "Clothing", "Other"];
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function itemStatusLabel(status) {
  if (status === "claimed") return "Claim approved · handover pending";
  if (status === "resolved") return "✓ Resolved";
  return "● Open";
}

function claimStatusLabel(status) {
  if (status === "approved") return "Approved · arrange handover with the owner";
  if (status === "rejected") return "Not approved · the item may still be available";
  return "Pending owner review";
}

function uploadImage(itemId, file, token, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${API}/api/items/${itemId}/image`);
    request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      let data = {};
      try { data = JSON.parse(request.responseText); } catch { /* handled below */ }
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new Error(data.error || "Image upload failed."));
    });
    request.addEventListener("error", () => reject(new Error("Could not reach the image upload service.")));
    const body = new FormData();
    body.append("image", file);
    request.send(body);
  });
}

function validateImage(file) {
  if (!file) return "";
  if (file.size > MAX_IMAGE_BYTES) return "Choose an image that is 5 MB or smaller.";
  if (file.type && !IMAGE_TYPES.has(file.type)) return "Choose a JPEG, PNG, or WebP image.";
  return "";
}

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
  const [myItemsLoaded, setMyItemsLoaded] = useState(false);
  const [myClaims, setMyClaims] = useState([]);
  const [ownerClaims, setOwnerClaims] = useState([]);
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimError, setClaimError] = useState("");
  const [claimingItemId, setClaimingItemId] = useState(null);
  const [claimExplanation, setClaimExplanation] = useState("");
  const [submittingClaimId, setSubmittingClaimId] = useState(null);
  const [decidingClaimId, setDecidingClaimId] = useState(null);
  const [imageUrls, setImageUrls] = useState({});
  const [formImageFile, setFormImageFile] = useState(null);
  const [editImageFile, setEditImageFile] = useState(null);
  const [uploadingItemId, setUploadingItemId] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
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
        setMyItemsLoaded(false);
        return;
      }
      setMyItemsLoaded(false);

      try {
        const response = await fetch(`${API}/api/items/mine`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!response.ok) throw new Error("Could not load your listings.");
        const data = await response.json();
        if (!cancelled) {
          setMyItemIds(new Set(data.map((item) => item.id)));
          setMyItemsLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setMyItemIds(new Set());
          setMyItemsLoaded(false);
        }
      }
    }

    loadMyItems();
    return () => { cancelled = true; };
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    async function loadClaims() {
      if (!session?.access_token) {
        setMyClaims([]);
        setOwnerClaims([]);
        return;
      }
      try {
        const response = await fetch(`${API}/api/claims/mine`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!response.ok) throw new Error("Could not load your claims.");
        const data = await response.json();
        if (!cancelled) setMyClaims(data);
      } catch {
        if (!cancelled) setMyClaims([]);
      }
    }
    loadClaims();
    return () => { cancelled = true; };
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    async function loadOwnerClaims() {
      if (listingView !== "review" || !session?.access_token) return;
      setClaimLoading(true);
      setClaimError("");
      try {
        const response = await fetch(`${API}/api/claims/for-my-listings`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load listing claims.");
        if (!cancelled) setOwnerClaims(data);
      } catch (err) {
        if (!cancelled) setClaimError(err.message);
      } finally {
        if (!cancelled) setClaimLoading(false);
      }
    }
    loadOwnerClaims();
    return () => { cancelled = true; };
  }, [listingView, session]);

  useEffect(() => {
    let cancelled = false;
    async function refreshImageUrls() {
      if (!session?.access_token) {
        setImageUrls({});
        return;
      }
      const imageItems = items.filter((item) => item.hasImage);
      const pairs = await Promise.all(imageItems.map(async (item) => {
        try {
          const response = await fetch(`${API}/api/items/${item.id}/image-url`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });
          if (!response.ok) return [item.id, null];
          const data = await response.json();
          return [item.id, data.url];
        } catch {
          return [item.id, null];
        }
      }));
      if (!cancelled) {
        setImageUrls(Object.fromEntries(pairs.filter(([, url]) => url)));
      }
    }
    refreshImageUrls();
    const timer = window.setInterval(refreshImageUrls, 4 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [items, session]);

  const filtered = useMemo(() => items.filter((item) => {
    const haystack = `${item.title} ${item.description} ${item.category} ${item.location}`.toLowerCase();
    return haystack.includes(query.toLowerCase())
      && (typeFilter === "all" || item.type === typeFilter)
      && (statusFilter === "all" || item.status === statusFilter)
      && (categoryFilter === "all" || item.category === categoryFilter)
      && (listingView !== "mine" || myItemIds.has(item.id));
  }), [items, query, typeFilter, statusFilter, categoryFilter, listingView, myItemIds]);

  const activeClaimItemIds = useMemo(
    () => new Set(myClaims.filter((claim) => claim.status === "pending" || claim.status === "approved").map((claim) => claim.itemId)),
    [myClaims],
  );

  async function refreshClaimLists() {
    if (!session?.access_token) return;
    const headers = { Authorization: `Bearer ${session.access_token}` };
    const [mineResponse, ownerResponse] = await Promise.all([
      fetch(`${API}/api/claims/mine`, { headers }),
      fetch(`${API}/api/claims/for-my-listings`, { headers }),
    ]);
    const [mine, owned] = await Promise.all([mineResponse.json(), ownerResponse.json()]);
    if (!mineResponse.ok || !ownerResponse.ok) {
      throw new Error(mine.error || owned.error || "Could not refresh claims.");
    }
    setMyClaims(mine);
    setOwnerClaims(owned);
  }

  async function submitClaim(event, itemId) {
    event.preventDefault();
    if (submittingClaimId) return;
    setClaimError("");
    setSubmittingClaimId(itemId);
    try {
      const response = await fetch(`${API}/api/items/${itemId}/claims`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ explanation: claimExplanation }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not submit your claim.");
      setMyClaims((current) => [data, ...current.filter((claim) => claim.id !== data.id)]);
      setClaimExplanation("");
      setClaimingItemId(null);
      setNotice("Your claim has been submitted for the listing owner's review.");
    } catch (err) {
      setClaimError(err.message);
    } finally {
      setSubmittingClaimId(null);
    }
  }

  async function decideClaim(claimId, decision) {
    if (decidingClaimId) return;
    setClaimError("");
    setDecidingClaimId(claimId);
    try {
      const response = await fetch(`${API}/api/claims/${claimId}/${decision}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not record the claim decision.");
      await Promise.all([refreshClaimLists(), loadItems()]);
      setNotice(decision === "approve"
        ? "Claim approved. The item is marked claimed pending handover."
        : "Claim rejected. The listing remains available to other claimants.");
    } catch (err) {
      setClaimError(err.message);
    } finally {
      setDecidingClaimId(null);
    }
  }

  
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

    let postedItem = data;
    setItems((current) => [postedItem, ...current]);
    setMyItemIds((current) => new Set([...current, data.id]));

    let uploadError = "";
    let imageCleanupPending = false;
    if (formImageFile) {
      setUploadingItemId(data.id);
      setUploadProgress(0);
      try {
        const imageResult = await uploadImage(data.id, formImageFile, session.access_token, setUploadProgress);
        imageCleanupPending = Boolean(imageResult.cleanupPending);
        postedItem = { ...data, hasImage: true };
        setItems((current) => current.map((item) => item.id === data.id ? postedItem : item));
      } catch (err) {
        uploadError = `Listing posted, but its image could not be uploaded: ${err.message}`;
      } finally {
        setUploadingItemId(null);
      }
    }

    setForm({
      title: "",
      type: "lost",
      category: "Electronics",
      location: "",
      date: new Date().toISOString().slice(0, 10),
      description: "",
    });

    setShowForm(false);
    if (formImageFile && !uploadError) setNotice(imageCleanupPending
      ? "Your listing and image were posted; old image cleanup needs a retry."
      : "Your listing and image have been posted.");
    else if (!uploadError) setNotice("Your listing has been posted.");
    if (uploadError) setError(uploadError);
    setFormImageFile(null);
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
    setEditImageFile(null);
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
      let updatedItem = data;
      setItems((current) => current.map((item) => item.id === id ? updatedItem : item));
      let uploadError = "";
      let imageCleanupPending = false;
      if (editImageFile) {
        setUploadingItemId(id);
        setUploadProgress(0);
        try {
          const imageResult = await uploadImage(id, editImageFile, session.access_token, setUploadProgress);
          imageCleanupPending = Boolean(imageResult.cleanupPending);
          updatedItem = { ...data, hasImage: true };
          setItems((current) => current.map((item) => item.id === id ? updatedItem : item));
        } catch (err) {
          uploadError = `Listing updated, but its image could not be uploaded: ${err.message}`;
        } finally {
          setUploadingItemId(null);
        }
      }
      setEditingItemId(null);
      setEditImageFile(null);
      if (uploadError) setError(uploadError);
      else setNotice(imageCleanupPending
        ? "Listing and image updated; old image cleanup needs a retry."
        : editImageFile ? "Listing and image updated." : "Your listing has been updated.");
    } catch (err) {
      setError(err.message || "Could not update listing.");
    }
  }

  async function removeItemImage(id) {
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${API}/api/items/${id}/image`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not remove image.");
      setItems((current) => current.map((item) => item.id === id ? { ...item, hasImage: false } : item));
      setImageUrls((current) => { const next = { ...current }; delete next[id]; return next; });
      setNotice(data.cleanupPending ? "Image removed; storage cleanup will need a retry." : "Image removed.");
    } catch (err) {
      setError(err.message || "Could not remove image.");
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
      setNotice(data.cleanupPending
        ? "Your listing was deleted; image storage cleanup needs a retry."
        : "Your listing has been deleted.");
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

              <label>
                Item photo (optional)
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    const problem = validateImage(file);
                    if (problem) {
                      setFormImageFile(null);
                      setError(problem);
                      event.target.value = "";
                      return;
                    }
                    setError("");
                    setFormImageFile(file);
                  }}
                />
                <span className="field-hint">JPEG, PNG, or WebP, up to 5 MB. {formImageFile?.name || ""}</span>
              </label>

              <button className="primary-button" type="submit" disabled={uploadingItemId !== null}>
                {uploadingItemId && !items.some((item) => item.id === uploadingItemId)
                  ? `Uploading ${uploadProgress}%…`
                  : "Publish listing"}
              </button>
              {uploadingItemId && !items.some((item) => item.id === uploadingItemId) && (
                <progress className="upload-progress" max="100" value={uploadProgress} aria-label="Image upload progress" />
              )}
            </form>
          </section>
        )}

        <section className="listings">
          <div className="section-heading">
            <div>
              <p className="eyebrow">THE CAMPUS BOARD</p>
              <h2>{listingView === "claims" ? "My Claims" : listingView === "review" ? "Claims for My Listings" : "Recent listings"}</h2>
            </div>
            <span className="result-count">
              {listingView === "claims" ? `${myClaims.length} CLAIMS` : listingView === "review" ? `${ownerClaims.length} CLAIMS` : `${filtered.length} LISTINGS`}
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
              <option value="claims">My claims</option>
              <option value="review">Claims for my listings</option>
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
              <option value="claimed">Claimed · handover pending</option>
              <option value="resolved">Resolved</option>
              <option value="all">All statuses</option>
            </select>
          </div>

          {error && <div className="message error">{error}</div>}
          {notice && <div className="message success">{notice}</div>}
          {claimError && <div className="message error">{claimError}</div>}

          {listingView === "claims" ? (
            myClaims.length === 0 ? (
              <div className="empty"><span>◎</span><h3>No claims yet</h3><p>Claims you submit for found items will appear here.</p></div>
            ) : (
              <div className="card-grid">
                {myClaims.map((claim) => (
                  <article className="item-card claim-card" key={claim.id}>
                    <div className="card-top"><span className="type-pill found">MY CLAIM</span><span className={`status-dot ${claim.status}`}>{claimStatusLabel(claim.status)}</span></div>
                    <h3>{claim.item?.title || "Listing unavailable"}</h3>
                    {claim.item && <p className="field-hint">{claim.item.location} · {claim.item.date}</p>}
                    <p className="description">{claim.explanation}</p>
                    <div className="meta"><span>Submitted {new Date(claim.createdAt).toLocaleDateString()}</span>{claim.decidedAt && <span>Decision {new Date(claim.decidedAt).toLocaleDateString()}</span>}</div>
                    <p className="claim-feedback">{claimStatusLabel(claim.status)}</p>
                  </article>
                ))}
              </div>
            )
          ) : listingView === "review" ? (
            claimLoading ? <p className="empty">Loading claims for your listings…</p> : ownerClaims.length === 0 ? (
              <div className="empty"><span>◎</span><h3>No claims to review</h3><p>Claims on your found-item listings will appear here.</p></div>
            ) : (
              <div className="card-grid">
                {ownerClaims.map((claim) => (
                  <article className="item-card claim-card" key={claim.id}>
                    <div className="card-top"><span className="type-pill found">CLAIM FOR YOUR ITEM</span><span className={`status-dot ${claim.status}`}>{claimStatusLabel(claim.status)}</span></div>
                    <h3>{claim.item?.title || "Your listing"}</h3>
                    {claim.item && <p className="field-hint">{claim.item.location} · {claim.item.date}</p>}
                    <p className="description"><strong>Why they say it belongs to them:</strong><br />{claim.explanation}</p>
                    <div className="meta"><span>Submitted {new Date(claim.createdAt).toLocaleDateString()}</span></div>
                    {claim.status === "pending" && (
                      <div className="owner-actions">
                        <button className="primary-button" disabled={decidingClaimId !== null} onClick={() => decideClaim(claim.id, "approve")}>
                          {decidingClaimId === claim.id ? "Saving…" : "Approve claim"}
                        </button>
                        <button className="text-button" disabled={decidingClaimId !== null} onClick={() => decideClaim(claim.id, "reject")}>Reject</button>
                      </div>
                    )}
                    {claim.status === "approved" && (
                      <>
                        <p className="claim-feedback">Approved. Arrange a handover; the item remains claimed until you mark it resolved.</p>
                        <button className="text-button" type="button" onClick={() => { setListingView("mine"); setStatusFilter("claimed"); }}>
                          View item for handover ↗
                        </button>
                      </>
                    )}
                  </article>
                ))}
              </div>
            )
          ) : loading ? (
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
                      {itemStatusLabel(item.status)}
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
                      <label>Replace image (optional)
                        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => {
                          const file = event.target.files?.[0] || null;
                          const problem = validateImage(file);
                          if (problem) {
                            setEditImageFile(null);
                            setError(problem);
                            event.target.value = "";
                            return;
                          }
                          setError("");
                          setEditImageFile(file);
                        }} />
                        <span className="field-hint">JPEG, PNG, or WebP, up to 5 MB. {editImageFile?.name || ""}</span>
                      </label>
                      <button className="primary-button" type="submit" disabled={uploadingItemId === item.id}>
                        {uploadingItemId === item.id ? `Uploading ${uploadProgress}%…` : "Save changes"}
                      </button>
                      {uploadingItemId === item.id && <progress className="upload-progress" max="100" value={uploadProgress} aria-label="Image upload progress" />}
                      <button className="text-button" type="button" onClick={() => setEditingItemId(null)}>Cancel</button>
                    </form>
                  ) : (
                    <>
                      {item.hasImage && imageUrls[item.id] && (
                        <img className="item-image" src={imageUrls[item.id]} alt={`Photo of ${item.title}`} loading="lazy" />
                      )}
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
                      {uploadingItemId === item.id && <span className="field-hint">Uploading photo: {uploadProgress}%</span>}
                      {item.hasImage && (
                        <button className="text-button" onClick={() => removeItemImage(item.id)}>Remove photo</button>
                      )}
                      {(item.status === "open" || item.status === "claimed") && (
                        <button className="text-button" onClick={() => resolveItem(item.id)}>
                          {item.status === "claimed" ? "Mark handover complete ↗" : "Mark resolved ↗"}
                        </button>
                      )}
                      {editingItemId !== item.id && (
                        <button className="text-button" onClick={() => startEditing(item)}>Edit</button>
                      )}
                      <button className="text-button" onClick={() => deleteItem(item.id)}>Delete</button>
                    </div>
                  )}
                  {item.type === "found" && item.status === "open" && myItemsLoaded && !myItemIds.has(item.id) && (
                    <div className="claim-action">
                      {activeClaimItemIds.has(item.id) ? (
                        <button className="primary-button" type="button" disabled>Claim pending</button>
                      ) : claimingItemId === item.id ? (
                        <form className="listing-form" onSubmit={(event) => submitClaim(event, item.id)}>
                          <label>Why does this item belong to you?
                            <textarea required minLength="1" maxLength="500" rows="3" value={claimExplanation} onChange={(event) => setClaimExplanation(event.target.value)} placeholder="Share details that help the owner identify the item." />
                          </label>
                          <span className="field-hint">Keep sensitive information private. Maximum 500 characters.</span>
                          <button className="primary-button" type="submit" disabled={submittingClaimId !== null || !claimExplanation.trim()}>
                            {submittingClaimId === item.id ? "Submitting…" : "Submit claim"}
                          </button>
                          <button className="text-button" type="button" disabled={submittingClaimId !== null} onClick={() => { setClaimingItemId(null); setClaimExplanation(""); }}>Cancel</button>
                        </form>
                      ) : (
                        <button className="primary-button" type="button" onClick={() => { setClaimingItemId(item.id); setClaimExplanation(""); setClaimError(""); }}>Claim Item</button>
                      )}
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
