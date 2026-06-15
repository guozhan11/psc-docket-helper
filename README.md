# PSC Docket Helper

A React and Express web app for finding District of Columbia Public Service Commission news, notices, dockets, and regulatory records.

The app has two main parts:

- **Latest Regulatory Updates**: pulls real links from the official DCPSC Current PSC News page.
- **Docket Assistant**: uses Gemini on the server to help users search and understand DCPSC dockets and filings.

## Data Sources

News cards are not AI-generated. The server fetches and parses the official DCPSC Current PSC News page:

https://dcpsc.org/Newsroom/Current-PSC-News.aspx

The app extracts the latest titles, dates, summaries, and official `dcpsc.org` document links. Results are cached for 30 minutes. If the DCPSC page is temporarily unavailable, the server falls back to a bundled list of verified official DCPSC links.

The chat assistant can use Gemini with Google Search grounding, but generated responses are post-processed to normalize and repair links where possible.

## Tech Stack

- React
- TypeScript
- Vite
- Tailwind CSS
- Express
- Google Gemini API

## Local Setup

Prerequisites:

- Node.js
- npm
- A Gemini API key

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env.local
```

Set your API key in `.env.local`:

```bash
GEMINI_API_KEY="your_api_key_here"
```

Run the development server:

```bash
npm run dev
```

The app runs at:

```text
http://localhost:3000
```

## Production Build

Build the frontend and bundled Express server:

```bash
npm run build
```

Start the production server:

```bash
npm start
```

## Deploying on Render

Create a Render **Web Service** connected to this GitHub repository.

Use these settings:

```text
Language: Node
Build Command: npm install && npm run build
Start Command: npm start
```

Add this environment variable in the Render dashboard:

```text
GEMINI_API_KEY=your_api_key_here
```

Do not commit real API keys to the repository.

After setup, every push to the connected branch will trigger a Render deploy.

## Updating the Live Site

Make changes locally, then commit and push:

```bash
git add .
git commit -m "Describe your change"
git push
```

Render will rebuild and redeploy automatically.

## Scripts

```bash
npm run dev      # Start local Express + Vite dev server
npm run build    # Build frontend and server bundle
npm start        # Start production server
npm run lint     # Type-check the project
npm run clean    # Remove dist
```
