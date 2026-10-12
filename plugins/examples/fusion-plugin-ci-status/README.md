# CI Status Plugin

Polls CI status for branches and provides a custom API to query results. Useful for tracking the build status of feature branches created for Fusion tasks.

## Features

- **Branch Tracking**: Tracks a task's branch when the task enters a working lane of its board, whatever that lane is called
- **Periodic Polling**: Polls CI status at configurable intervals
- **Custom API**: Provides REST endpoints to query branch status
- **Automatic Cleanup**: Stops tracking a branch when Fusion reports the task completed, or when the task enters an archive lane

## Installation

### Option 1: Copy to plugins directory

```bash
cp -r fusion-plugin-ci-status ~/.fusion/plugins/
```

### Option 2: Install via CLI

```bash
fn plugin install /path/to/fusion-plugin-ci-status
```

## Configuration

### Settings Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `ciUrl` | string | Yes | — | Base URL for CI API |
| `pollIntervalMs` | number | No | `30000` | How often to poll CI status (milliseconds) |
| `branchPrefix` | string | No | `fusion/` | Only poll branches with this prefix |

## API Endpoints

The plugin provides the following REST endpoints at `/api/plugins/fusion-plugin-ci-status`:

### GET /status

Returns status of all tracked branches.

```json
{
  "branches": [
    {
      "branch": "fusion/fn-001",
      "status": "pending",
      "lastChecked": "2024-01-01T00:00:00.000Z",
      "url": "https://ci.example.com/builds/123"
    }
  ]
}
```

### GET /status/:branch

Returns status of a specific branch.

```json
{
  "branch": "fusion/fn-001",
  "status": "success",
  "lastChecked": "2024-01-01T00:00:00.000Z",
  "url": "https://ci.example.com/builds/123"
}
```

If the branch is not found, returns a 404 error.

### POST /refresh

Triggers an immediate CI status refresh for all tracked branches.

```json
{
  "branches": [...],
  "refreshed": true
}
```

## How It Works

1. **Branch Creation**: When a task enters a working lane, the plugin's `onTaskMoved` hook creates a branch name using the configured prefix (default: `fusion/`) combined with the task ID (lowercased)
2. **CI Polling**: At the configured interval, the plugin polls the CI API to get status updates for all tracked branches
3. **CI Integration**: The plugin sends a POST request to `{ciUrl}/status` with the list of branch names
4. **Branch Cleanup**: When Fusion reports a task completed, the plugin's `onTaskCompleted` hook removes the branch from tracking. Fusion calls that hook when a task reaches the board's complete column, whatever that column is called. A task that enters an archive lane is removed from tracking too

### Boards with renamed columns

A workflow can give its columns other ids than the default board's, so the plugin never compares a column id. `onTaskMoved` asks Fusion what the column is for:

```typescript
if (await taskColumnHasLaneRole(ctx.taskStore, task.id, toColumn, "wip")) {
  // start tracking
}
if (await taskColumnHasLaneRole(ctx.taskStore, task.id, toColumn, "archived")) {
  // stop tracking
}
```

`taskColumnHasLaneRole` comes from the plugin SDK. Fusion answers from the task's own workflow, so the check works on a board with several working lanes and on a board whose archive lane has another id. On the default board the working lane is `in-progress` and the archive lane is `archived`.

Cleanup on completion works on every board too, because Fusion decides which column is the complete one before it calls `onTaskCompleted`.

If you copy this plugin, keep asking for the lane's role. A comparison with a column id such as `in-progress` works on the default board only.

## CI API Integration

The plugin expects your CI system to expose a `/status` endpoint that accepts:

```json
{
  "branches": ["fusion/fn-001", "fusion/fn-002"]
}
```

And returns:

```json
{
  "statuses": [
    {
      "branch": "fusion/fn-001",
      "status": "success",
      "url": "https://ci.example.com/builds/123"
    }
  ]
}
```

### Supported Status Values

- `pending` — Initial state when branch is first tracked
- `running` — CI is building
- `success` — CI passed
- `failed` — CI failed
- `cancelled` — CI was cancelled

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm build
```

## License

MIT
