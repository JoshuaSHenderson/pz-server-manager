// Restart automation, and the server's own settings.
//
// Ordered deliberately: the manager's own automation first (it applies instantly), then the two
// things that write to disk and need a server restart.

import { PaneHead } from '../../components/ui'
import { Automation } from './Automation'
import { ServerSettings } from './ServerSettings'
import { Sandbox } from './Sandbox'

export function Config() {
  return (
    <div className="tab-pane active">
      <PaneHead title="Config" subtitle="Restart automation, and the server's own settings" />
      <Automation />
      <ServerSettings />
      <Sandbox />
    </div>
  )
}
