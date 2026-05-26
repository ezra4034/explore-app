import { useState, useEffect, useRef } from "react";
import * as THREE from "three";

// ── API Keys ──────────────────────────────────────────────────────────────────
const GROQ_KEY = import.meta.env.VITE_GROQ_KEY;
const GEO_KEY  = import.meta.env.VITE_GEO_KEY;
// ── Quick Suggestions ─────────────────────────────────────────────────────────
const SUGGESTIONS = [
  ["🍣", "Romantic sushi nearby"],
  ["☕", "Specialty coffee shops"],
  ["🏨", "Luxury hotels"],
  ["🎭", "Local museums"],
  ["🍷", "Wine bars"],
  ["🌿", "Scenic parks"],
];

// ── Fibonacci sphere point cloud ───────────────────────────────────────────────
function fibSphere(n, r) {
  const phi = Math.PI * (3 - Math.sqrt(5));
  const out = [];
  for (let i = 0; i < n; i++) {
    const y   = 1 - (i / (n - 1)) * 2;
    const rho = Math.sqrt(Math.max(0, 1 - y * y));
    const th  = phi * i;
    out.push(new THREE.Vector3(Math.cos(th) * rho * r, y * r, Math.sin(th) * rho * r));
  }
  return out;
}

// ── Styles ────────────────────────────────────────────────────────────────────
const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ::placeholder { color: rgba(255,255,255,.28) !important; }
  ::-webkit-scrollbar { width: 0; }

  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(18px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes slideUp {
    from { transform: translateY(100%); }
    to   { transform: translateY(0); }
  }
  @keyframes bounce {
    0%, 60%, 100% { transform: translateY(0);   opacity: .45; }
    30%           { transform: translateY(-8px); opacity: 1;   }
  }
  @keyframes pulse-ring {
    0%, 100% { opacity: .15; transform: scale(1); }
    50%      { opacity: .5;  transform: scale(1.04); }
  }
  @keyframes spin {
    from { transform: rotate(0deg);   }
    to   { transform: rotate(360deg); }
  }

  .pill-btn:hover  { background: rgba(255,255,255,.1) !important; }
  .place-card:hover { background: rgba(255,255,255,.08) !important; }
  .explore-btn:not(:disabled):hover { filter: brightness(1.15); transform: scale(1.01); }
  .explore-btn:not(:disabled):active { transform: scale(.98); }
  .reset-btn:hover { background: rgba(255,255,255,.12) !important; }
`;

// ── Component ─────────────────────────────────────────────────────────────────
export default function App() {
  const mountRef = useRef(null);
  // Animation state mutated by both Three.js loop and React handlers
  const animRef  = useRef({ camZ: 5.5, camZTarget: 5.5, searching: false });
  // Refs to Three.js objects we animate at runtime
  const threeRef = useRef({});

  const [phase,   setPhase]   = useState("idle");   // idle | zooming | results
  const [query,   setQuery]   = useState("");
  const [loading, setLoading] = useState(false);
  const [spots,   setSpots]   = useState([]);
  const [insight, setInsight] = useState("");

  // ── Three.js scene setup ────────────────────────────────────────────────────
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const W = el.offsetWidth  || window.innerWidth;
    const H = el.offsetHeight || window.innerHeight;

    // Core
    const scene = new THREE.Scene();
    const cam   = new THREE.PerspectiveCamera(50, W / H, 0.01, 500);
    cam.position.z = 5.5;

    const rend = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    rend.setSize(W, H);
    rend.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(rend.domElement);

    // ── Globe ────────────────────────────────────────────────────────────────
    const R = 2.0, N = 500;
    const pts   = fibSphere(N, R);
    const globe = new THREE.Group();
    scene.add(globe);

    // — Dot cloud —
    const dGeo = new THREE.BufferGeometry();
    const dPos = new Float32Array(N * 3);
    const dCol = new Float32Array(N * 3);
    pts.forEach((p, i) => {
      dPos[i*3]   = p.x;
      dPos[i*3+1] = p.y;
      dPos[i*3+2] = p.z;
      const lat     = Math.abs(p.y / R);   // 0 = equator, 1 = pole
      dCol[i*3]   = 0.28 + lat * 0.30;    // R – icier toward poles
      dCol[i*3+1] = 0.70 + lat * 0.12;    // G
      dCol[i*3+2] = 1.00;                 // B – always full blue
    });
    dGeo.setAttribute("position", new THREE.BufferAttribute(dPos, 3));
    dGeo.setAttribute("color",    new THREE.BufferAttribute(dCol, 3));
    const dMat = new THREE.PointsMaterial({
      size: 0.038, sizeAttenuation: true, vertexColors: true,
    });
    globe.add(new THREE.Points(dGeo, dMat));

    // — Connection lines between nearby dots —
    const lv = [];
    let lc = 0;
    for (let i = 0; i < N && lc < 900; i++) {
      for (let j = i + 1; j < N && lc < 900; j++) {
        if (pts[i].distanceTo(pts[j]) < 0.62) {
          lv.push(
            pts[i].x, pts[i].y, pts[i].z,
            pts[j].x, pts[j].y, pts[j].z,
          );
          lc++;
        }
      }
    }
    const lGeo = new THREE.BufferGeometry();
    lGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(lv), 3));
    const lMat = new THREE.LineBasicMaterial({ color: 0x4FC3F7, opacity: 0.18, transparent: true });
    globe.add(new THREE.LineSegments(lGeo, lMat));

    // — Faint latitude/longitude wireframe —
    globe.add(new THREE.Mesh(
      new THREE.SphereGeometry(R, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0x1E7ECC, wireframe: true, opacity: 0.04, transparent: true }),
    ));

    // — Atmospheric glow (back-face only, stays fixed) —
    const atm = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.12, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x006FFF, opacity: 0.09, transparent: true, side: THREE.BackSide }),
    );
    scene.add(atm);

    // — Equatorial scanning ring (pulses during search) —
    const r1Mat  = new THREE.MeshBasicMaterial({ color: 0x00D4FF, opacity: 0, transparent: true });
    const ring1  = new THREE.Mesh(new THREE.TorusGeometry(R * 1.012, 0.007, 8, 120), r1Mat);
    ring1.rotation.x = Math.PI / 2;
    globe.add(ring1);

    // — Tilted secondary ring —
    const r2Mat = new THREE.MeshBasicMaterial({ color: 0x0066FF, opacity: 0, transparent: true });
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(R * 1.022, 0.005, 8, 120), r2Mat);
    ring2.rotation.x = Math.PI / 3.5;
    globe.add(ring2);

    // — Stars —
    const sGeo = new THREE.BufferGeometry();
    const sPos = new Float32Array(3000 * 3);
    for (let i = 0; i < sPos.length; i++) sPos[i] = (Math.random() - 0.5) * 300;
    sGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
    scene.add(new THREE.Points(
      sGeo,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.15, opacity: 0.40, transparent: true }),
    ));

    // Store mutable Three.js objects for the animation loop
    threeRef.current = { globe, dMat, lMat, r1Mat, r2Mat, ring2, atm };

    // ── Mouse parallax ───────────────────────────────────────────────────────
    const mouse = { x: 0, y: 0 };
    const onMM  = e => {
      mouse.x = (e.clientX / window.innerWidth  - 0.5) * 2;
      mouse.y = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("mousemove", onMM);

    // ── Animation loop ───────────────────────────────────────────────────────
    const a = animRef.current;
    let f = 0, raf;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      f++;

      // Smooth camera zoom
      a.camZ += (a.camZTarget - a.camZ) * 0.045;
      cam.position.z = a.camZ;

      // Globe rotation (faster while searching)
      globe.rotation.y += a.searching ? 0.008 : 0.0025;
      // Subtle mouse parallax tilt
      globe.rotation.x += (mouse.y * 0.12 - globe.rotation.x) * 0.025;
      globe.rotation.z += (-mouse.x * 0.04 - globe.rotation.z) * 0.025;

      // Atmosphere follows globe's world position (not rotation)
      atm.position.copy(globe.position);

      if (a.searching) {
        // Pulsing rings
        const pulse = (Math.sin(f * 0.1) + 1) * 0.5;
        r1Mat.opacity = 0.50 + pulse * 0.45;
        r2Mat.opacity = 0.22 + pulse * 0.30;
        ring2.rotation.z = f * 0.025;        // secondary ring orbits
        lMat.opacity     = 0.40;             // lines brighten
        dMat.size        = 0.048;            // dots grow
      } else {
        r1Mat.opacity *= 0.92;               // rings fade out
        r2Mat.opacity *= 0.92;
        lMat.opacity  += (0.18 - lMat.opacity) * 0.04;
        dMat.size     += (0.038 - dMat.size)   * 0.05;
      }

      rend.render(scene, cam);
    };
    tick();

    // ── Resize handler ───────────────────────────────────────────────────────
    const onResize = () => {
      const nW = el.offsetWidth  || window.innerWidth;
      const nH = el.offsetHeight || window.innerHeight;
      cam.aspect = nW / nH;
      cam.updateProjectionMatrix();
      rend.setSize(nW, nH);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMM);
      window.removeEventListener("resize", onResize);
      rend.dispose();
      if (el.contains(rend.domElement)) el.removeChild(rend.domElement);
    };
  }, []);

  // ── Search handler ───────────────────────────────────────────────────────────
  const search = async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setPhase("zooming");

    // Trigger dramatic zoom-into-Earth animation
    animRef.current.camZTarget = 2.1;
    animRef.current.searching  = true;

    // Let the zoom play (1.4 s)
    await new Promise(r => setTimeout(r, 1400));

    try {
      // 1 — Geolocate user
      const pos = await new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 12000 })
      );
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      // 2 — Ask Groq to extract a Geoapify category
      const g1  = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content: "Return ONLY one Geoapify place category word (restaurant, cafe, hotel, museum, park, bar, nightlife, shopping, spa, beach). No explanation, no punctuation.",
            },
            { role: "user", content: query },
          ],
          temperature: 0.2,
        }),
      });
      const cat = (await g1.json()).choices[0].message.content.trim().toLowerCase().split(/\W/)[0];

      // 3 — Fetch nearby places from Geoapify
      const geoResp = await fetch(
        `https://api.geoapify.com/v2/places?categories=${cat}&filter=circle:${lon},${lat},5000&bias=proximity:${lon},${lat}&limit=8&apiKey=${GEO_KEY}`
      );
      const found = (await geoResp.json()).features || [];
      setSpots(found);

      // 4 — AI curation insight
      const sum = found
        .map(p => `${p.properties.name || "?"} — ${p.properties.address_line2 || ""}`)
        .join("\n");
      const g2 = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content: "You are a discerning luxury travel curator. 2–3 elegant sentences max. Be specific and opinionated.",
            },
            {
              role: "user",
              content: `User wants: ${query}\n\nNearby options:\n${sum}\n\nWhich is best and why?`,
            },
          ],
          temperature: 0.85,
        }),
      });
      setInsight((await g2.json()).choices[0].message.content);

      // Transition: pull camera back, reveal results sheet
      animRef.current.searching  = false;
      animRef.current.camZTarget = 4.0;
      await new Promise(r => setTimeout(r, 350));
      setPhase("results");

    } catch (err) {
      console.error(err);
      animRef.current.searching  = false;
      animRef.current.camZTarget = 5.5;
      setPhase("idle");
      alert(`Error: ${err.message || "Something went wrong. Check your API keys and location permissions."}`);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setPhase("idle");
    setSpots([]);
    setInsight("");
    setQuery("");
    animRef.current.camZTarget = 5.5;
    animRef.current.searching  = false;
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={{
      width: "100vw", height: "100vh", overflow: "hidden", position: "relative",
      background: "#040410",
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif',
      color: "#fff",
    }}>
      <style>{CSS}</style>

      {/* ── Three.js canvas mount ────────────────────────────────────────────── */}
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />

      {/* ── Navigation bar ──────────────────────────────────────────────────── */}
      <nav style={{
        position: "absolute", top: 0, left: 0, right: 0, zIndex: 10,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "22px 28px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 34, height: 34, borderRadius: "50%",
            background: "rgba(255,255,255,0.08)", backdropFilter: "blur(20px)",
            border: "0.5px solid rgba(255,255,255,0.14)",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15,
          }}>✦</div>
          <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-.025em" }}>Explore</span>
        </div>

        {phase !== "idle" && (
          <button
            onClick={reset}
            className="reset-btn"
            style={{
              padding: "8px 20px", borderRadius: 100,
              background: "rgba(255,255,255,0.07)", backdropFilter: "blur(20px)",
              border: "0.5px solid rgba(255,255,255,0.13)",
              color: "rgba(255,255,255,.8)", fontSize: 13, fontWeight: 500,
              cursor: "pointer", fontFamily: "inherit", transition: "background .2s",
            }}
          >← New search</button>
        )}
      </nav>

      {/* ── IDLE: hero + search bar ──────────────────────────────────────────── */}
      {phase === "idle" && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10,
          padding: "0 24px 52px",
          background: "linear-gradient(to top, #040410 22%, rgba(4,4,16,.78) 58%, transparent)",
          animation: "fadeIn .5s ease",
        }}>
          <div style={{ maxWidth: 560, margin: "0 auto" }}>

            <h1 style={{
              fontSize: 56, fontWeight: 700, letterSpacing: "-.055em",
              margin: "0 0 8px", lineHeight: 1,
              background: "linear-gradient(160deg,#fff 38%,rgba(255,255,255,.48))",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            }}>Where to?</h1>

            <p style={{ fontSize: 17, color: "rgba(255,255,255,.42)", margin: "0 0 28px" }}>
              Discover places near you, powered by AI
            </p>

            {/* Search input */}
            <div style={{
              display: "flex", gap: 8,
              background: "rgba(255,255,255,0.07)", backdropFilter: "blur(30px)",
              border: "0.5px solid rgba(255,255,255,0.11)", borderRadius: 20, padding: 6,
            }}>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === "Enter" && search()}
                placeholder="romantic sushi with a luxury vibe..."
                style={{
                  flex: 1, background: "transparent", border: "none", outline: "none",
                  color: "#fff", fontSize: 16, padding: "13px 16px",
                  fontFamily: "inherit", caretColor: "#0A84FF",
                }}
              />
              <button
                onClick={search}
                disabled={!query.trim() || loading}
                className="explore-btn"
                style={{
                  padding: "13px 26px", borderRadius: 14,
                  background: query.trim() ? "#0A84FF" : "rgba(255,255,255,0.1)",
                  border: "none", color: "#fff", fontSize: 15, fontWeight: 600,
                  cursor: query.trim() ? "pointer" : "default",
                  fontFamily: "inherit", letterSpacing: "-.01em",
                  transition: "all .2s, transform .1s",
                }}
              >Explore</button>
            </div>

            {/* Suggestion pills */}
            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              {SUGGESTIONS.map(([emoji, text]) => (
                <button
                  key={text}
                  onClick={() => setQuery(text)}
                  className="pill-btn"
                  style={{
                    padding: "7px 14px", borderRadius: 100,
                    background: "rgba(255,255,255,0.055)",
                    border: "0.5px solid rgba(255,255,255,0.09)",
                    color: "rgba(255,255,255,.62)", fontSize: 13,
                    cursor: "pointer", fontFamily: "inherit", transition: "background .15s",
                  }}
                >{emoji} {text}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── ZOOMING: zoom-into-earth + searching indicator ──────────────────── */}
      {phase === "zooming" && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 10,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "flex-end",
          paddingBottom: 90, animation: "fadeIn .45s ease",
        }}>
          <div style={{ textAlign: "center" }}>
            {/* Spinner badge */}
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 10,
              padding: "11px 22px", borderRadius: 100,
              background: "rgba(255,255,255,0.06)", backdropFilter: "blur(24px)",
              border: "0.5px solid rgba(255,255,255,0.1)", marginBottom: 18,
            }}>
              <div style={{ display: "flex", gap: 5 }}>
                {[0,1,2].map(i => (
                  <div key={i} style={{
                    width: 5, height: 5, borderRadius: "50%", background: "#4FC3F7",
                    animation: `bounce 1.15s ease-in-out ${i * 0.2}s infinite`,
                  }} />
                ))}
              </div>
              <span style={{ fontSize: 14, color: "rgba(255,255,255,.55)", fontWeight: 500, letterSpacing: "-.01em" }}>
                Scanning nearby
              </span>
            </div>

            <div style={{
              fontSize: 26, fontWeight: 600, letterSpacing: "-.04em",
              background: "linear-gradient(160deg,#fff 50%,rgba(255,255,255,.55))",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            }}>"{query}"</div>
          </div>
        </div>
      )}

      {/* ── RESULTS: Apple Maps-style bottom sheet ──────────────────────────── */}
      {phase === "results" && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10,
          height: "calc(100vh - 145px)", overflowY: "auto",
          background: "rgba(7,7,19,0.90)", backdropFilter: "blur(44px) saturate(180%)",
          borderTop: "0.5px solid rgba(255,255,255,0.09)",
          borderRadius: "28px 28px 0 0",
          animation: "slideUp .55s cubic-bezier(.16,1,.3,1)",
        }}>
          {/* Pull handle */}
          <div style={{ display: "flex", justifyContent: "center", padding: "14px 0 6px" }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.2)" }} />
          </div>

          <div style={{ padding: "4px 24px 72px" }}>
            {/* Header */}
            <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-.045em", marginBottom: 4 }}>
              {spots.length} places found
            </div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,.35)", marginBottom: 24 }}>
              for "{query}"
            </div>

            {/* AI curation card */}
            {insight && (
              <div style={{
                background: "rgba(10,132,255,.08)",
                border: "0.5px solid rgba(10,132,255,.22)",
                borderRadius: 18, padding: "18px 20px", marginBottom: 26,
                animation: "fadeInUp .4s ease .1s both",
              }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 6,
                  fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase",
                  color: "#0A84FF", fontWeight: 600, marginBottom: 12,
                }}>
                  <span style={{ fontSize: 14 }}>✦</span> AI Curation
                </div>
                <p style={{
                  fontSize: 14, color: "rgba(255,255,255,.78)",
                  lineHeight: 1.78, margin: 0, whiteSpace: "pre-wrap",
                }}>{insight}</p>
              </div>
            )}

            {/* Place cards grid */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: 12,
            }}>
              {spots.map((place, i) => (
                <a
                  key={i}
                  href={`https://www.google.com/maps?q=${place.geometry.coordinates[1]},${place.geometry.coordinates[0]}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: "none" }}
                >
                  <div
                    className="place-card"
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      border: "0.5px solid rgba(255,255,255,0.09)",
                      borderRadius: 18, padding: 18,
                      cursor: "pointer", transition: "background .18s",
                      animation: `fadeInUp .42s ease ${i * 0.07}s both`,
                    }}
                  >
                    {/* Icon */}
                    <div style={{
                      width: 42, height: 42, borderRadius: 13,
                      background: "rgba(10,132,255,.12)",
                      border: "0.5px solid rgba(10,132,255,.22)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 18, marginBottom: 14,
                    }}>📍</div>

                    {/* Name */}
                    <div style={{
                      fontSize: 15, fontWeight: 600, lineHeight: 1.3,
                      color: "#fff", marginBottom: 5,
                    }}>
                      {place.properties.name || "Unknown Place"}
                    </div>

                    {/* Address */}
                    <div style={{
                      fontSize: 12, color: "rgba(255,255,255,.35)",
                      lineHeight: 1.45, marginBottom: 14,
                    }}>
                      {place.properties.address_line2 || "No address available"}
                    </div>

                    {/* CTA */}
                    <div style={{
                      fontSize: 13, color: "#0A84FF", fontWeight: 500,
                      letterSpacing: "-.01em",
                    }}>Open in Maps →</div>
                  </div>
                </a>
              ))}
            </div>

            {/* Setup instructions (shown if no results yet) */}
            {spots.length === 0 && !loading && (
              <div style={{
                background: "rgba(255,255,255,0.04)",
                border: "0.5px solid rgba(255,255,255,0.08)",
                borderRadius: 18, padding: "24px 20px", marginTop: 8,
                animation: "fadeInUp .4s ease both",
              }}>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,.4)", lineHeight: 1.8, fontFamily: "monospace" }}>
                  <div style={{ color: "#fff", fontFamily: "inherit", fontWeight: 600, marginBottom: 12 }}>
                    No results returned
                  </div>
                  <div>• Ensure <code style={{ color: "#0A84FF" }}>GROQ_KEY</code> is set in the code</div>
                  <div>• Ensure <code style={{ color: "#0A84FF" }}>GEO_KEY</code> is set in the code</div>
                  <div>• Allow location permissions in your browser</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
