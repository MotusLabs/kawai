## MODIFIED Requirements

### Requirement: The header shows the session's identity and status with wrapping metadata
The chat view header SHALL show status (color and word) and the session name, which opens rename on click, in its identity row. Supporting metadata SHALL show the provider and model labels (one label when they are equal), the model the agent reported when known, and project's last path segment, with full path on hover. Metadata SHALL wrap when needed. Task and paused context SHALL have a separate wrapping row when present.

#### Scenario: Live session identity
- **WHEN** a chat view is open for a live session on model `Default` of provider `Claude` whose agent reported model `claude-opus-5-5` in `/home/coder/kawai`
- **THEN** the identity row shows the status word and session name without a ` · Chat` suffix, and supporting metadata shows `Claude`, `Default`, `claude-opus-5-5`, and `kawai`, with `/home/coder/kawai` available on hover

#### Scenario: Provider and model labels
- **WHEN** a session runs on model GLM Flash of provider Z.AI and its agent reported model `glm-5.3-flash` in `/home/coder/kawai`
- **THEN** supporting metadata shows `Z.AI`, `GLM Flash`, `glm-5.3-flash`, and `kawai`

#### Scenario: Status indicator follows the session
- **WHEN** the session's status changes from working to waiting, or the connection drops
- **THEN** the indicator's word and color change to the new status, or to the connection state while disconnected, and an archived chat shows `archived`

#### Scenario: Task and paused chips
- **WHEN** the session works on a task and is paused at a usage limit
- **THEN** a separate wrapping context row shows a task link opening that task on the Team page and the paused notice, with readable task and pause text

#### Scenario: Long metadata
- **WHEN** provider, model, project, or task labels exceed the space available on one row
- **THEN** they wrap across available rows and long unbroken values can break within their own content without forcing horizontal header scrolling

#### Scenario: Rename from the name
- **WHEN** the user clicks the session name
- **THEN** the name becomes an editable field with the existing rename behavior
