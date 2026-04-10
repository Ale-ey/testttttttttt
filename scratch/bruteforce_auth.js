const crypto = require("node:crypto");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "../.env.local") });

const publicKey = process.env.REGIONDO_PUBLIC_KEY;
const privateKey = process.env.REGIONDO_PRIVATE_KEY;
const baseUrl = "https://api.regiondo.com/v1/supplier/bookings";

const params = {
  limit: 1,
  offset: 0,
  date_range_by: "date_of_event",
  date_range: "2026-04-08,2027-01-31",
  status: "sent",
  store_locale: "de-AT"
};

async function testAuth() {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  
  const variations = [];

  // Variation 1: As provided in Vite plugin (forward.toString() using URLSearchParams)
  const sp1 = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => sp1.set(k, v));
  variations.push({ name: "Vite Plugin Style (URLSearchParams)", qs: sp1.toString() });

  // Variation 2: Sorted alphabetically
  const sp2 = new URLSearchParams();
  Object.keys(params).sort().forEach(k => sp2.set(k, params[k]));
  variations.push({ name: "Sorted Alphabetically", qs: sp2.toString() });

  // Variation 3: Empty query string (if API expects to sign just key+time)
  variations.push({ name: "No query string in hash", qs: "" });

  // Variation 4: Raw comma (unencoded) - unlikely but possible
  const rawQs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
  variations.push({ name: "Unencoded Query String", qs: rawQs });

  // Variation 5: Swap key and time
  // stringToHash = publicKey + timestamp + qs (instead of timestamp + publicKey + qs)
  
  for (const v of variations) {
    console.log(`Testing variation: ${v.name}`);
    const stringToHash = timestamp + publicKey + v.qs;
    const hash = crypto.createHmac("sha256", privateKey).update(stringToHash).digest("hex");
    
    // We always use the encoded QS for the actual URL
    const finalQs = variations[0].qs; 
    const url = `${baseUrl}?${finalQs}`;

    try {
      const res = await fetch(url, {
        headers: {
          "X-API-ID": publicKey,
          "X-API-TIME": timestamp,
          "X-API-HASH": hash,
          "Accept": "application/json"
        }
      });
      console.log(`  Result: ${res.status}`);
      if (res.ok) {
        console.log(`  SUCCESS! Variation found: ${v.name}`);
        break;
      } else {
          const body = await res.text();
          console.log(`  Body: ${body.slice(0, 100)}`);
      }
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
  }
  
  // Try one more: publicKey + timestamp + qs
  console.log("Testing variation: publicKey + timestamp + qs");
  for (const v of variations.slice(0, 2)) {
    const stringToHash = publicKey + timestamp + v.qs;
    const hash = crypto.createHmac("sha256", privateKey).update(stringToHash).digest("hex");
    const url = `${baseUrl}?${v.qs}`;
    const res = await fetch(url, {
        headers: {
          "X-API-ID": publicKey,
          "X-API-TIME": timestamp,
          "X-API-HASH": hash,
          "Accept": "application/json"
        }
    });
    console.log(`  Result: ${res.status} (${v.name})`);
    if (res.ok) {
        console.log(`  SUCCESS! Variation found: publicKey + timestamp + qs (${v.name})`);
        break;
    }
  }
}

testAuth();
