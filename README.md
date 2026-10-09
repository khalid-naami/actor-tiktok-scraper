# TikTok Ultimate All-in-One Scraper (Enterprise Edition)

The most comprehensive, high-speed, and stealthy **TikTok Intelligence & Data Scraper** on Apify.  
Built with **JavaScript (Node.js), Crawlee, and Playwright**, featuring automatic Rehydration JSON state extraction, **Photo Slideshows (Photo Reels) extraction**, and full B2B Lead discovery.

---

## 🌟 Modules & Features Supported

1. **Profiles & Influencer Leads**: Nickname, @username, verified badge, followers count, following count, total hearts/likes count, total videos, bio, external link, **direct business email and phone number extraction**.
2. **Standard Videos**: Direct video play URLs, cover thumbnails, views (`playCount`), likes (`diggCount`), comments count, share count, and collect/save count.
3. **Photo Slideshows (TikTok Photo Reels)**: Full carousel of high-definition photo URLs in multi-image TikTok posts.
4. **Comments & Replies**: Comment text, author handles, timestamps, and comment like counts.
5. **Sounds & Trending Music**: Music track title, artist name, and original audio indicators.
6. **Hashtags & Challenges**: Total hashtag view volume and grid of top videos.
7. **Keyword Search**: Discovers trending videos and creators by keyword queries.

---

## 📥 Input Configuration

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `scrapeMode` | Select | `"AUTO_DETECT"` | Options: `AUTO_DETECT`, `PROFILES`, `VIDEOS`, `PHOTO_SLIDES`, `COMMENTS`, `MUSIC_SOUNDS`, `HASHTAGS`, `KEYWORD_SEARCH`, `TIKTOK_SHOP`, `LIVE_METADATA`. |
| `targetUrls` | Array | Required | Profile links, video links, photo slides, or handles (e.g. `https://www.tiktok.com/@tiktok`). |
| `searchKeywords` | Array | `[]` | Keywords or hashtags to search. |
| `maxItems` | Integer | `20` | Maximum items to extract. |
| `maxCommentsPerVideo` | Integer | `15` | Max comments per video. |
| `extractEmailAndPhone` | Boolean | `true` | Extract emails and phone numbers from bios. |
| `proxyConfiguration` | Object | `RESIDENTIAL` | Apify Residential Proxy configuration. |
| `customCookies` | String | `""` | Optional TikTok session cookies (`sessionid`, `ttwid`). |

---

## 📤 Sample Output (Photo Slideshow Reel)

```json
{
  "type": "PHOTO_SLIDES",
  "url": "https://www.tiktok.com/@creator/video/...",
  "id": "7420000000000000000",
  "desc": "Check out these 5 aesthetic photography spots! #photography #travel",
  "isPhotoSlide": true,
  "photoUrls": [
    "https://p16-sign.tiktokcdn-us.com/tos-useast5...jpg",
    "https://p16-sign.tiktokcdn-us.com/tos-useast5...jpg",
    "https://p16-sign.tiktokcdn-us.com/tos-useast5...jpg"
  ],
  "authorUsername": "creator",
  "playCount": 450000,
  "diggCount": 38000,
  "commentCount": 850,
  "musicTitle": "Original Sound - Creator",
  "scrapedAt": "2026-10-09T09:55:00.000Z"
}
```

---

## 🛡️ Anti-Block & Compliance
- Automatic dismissal of login overlays & app installation prompts.
- Emulates Chrome desktop browser client headers.
- Uses Residential Proxy rotation by default.

---

## 📄 License
Apache-2.0
