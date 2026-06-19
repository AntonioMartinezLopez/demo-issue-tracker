# Build context must be the PROJECT ROOT (not mcp/) because the MCP server
# imports lib/types.ts from the parent directory.
# In docker-compose.yml, set:  build: { context: .., dockerfile: mcp/Dockerfile }

FROM node:22-alpine

WORKDIR /app

# Copy only what's needed for the MCP server.
# lib/ is needed because mcp/src/index.ts imports ../../lib/types.js.
COPY mcp/package.json mcp/package-lock.json ./mcp/
COPY lib/ ./lib/

# Install dependencies inside the mcp/ subfolder.
RUN cd mcp && npm ci --omit=dev

COPY mcp/src/ ./mcp/src/
COPY mcp/tsconfig.json ./mcp/

WORKDIR /app/mcp

# tsx runs TypeScript directly — no compile step needed.
# For production, switch to: RUN npm run build && CMD ["node", "dist/mcp/src/index.js"]
CMD ["npx", "tsx", "src/index.ts"]
