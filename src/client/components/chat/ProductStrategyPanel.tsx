// The Product Strategy side panel: the chat side slot's host of the
// host-agnostic ProductStrategyView, supplying only the slot's chrome. The
// view keeps every strategy action; the panel adds nothing.
import type { SendClientMessage } from '@shared/types'
import type { StrategyView } from '../../stores/strategyStore'
import ProductStrategyView from '../team/ProductStrategyView'

export default function ProductStrategyPanel({ teamPath, view, sendMessage, connected, onClose }: {
  teamPath: string; view: StrategyView; sendMessage: SendClientMessage; connected: boolean; onClose: () => void
}) {
  return <aside className="flex min-h-0 w-full flex-col border-l border-border md:w-[28rem]">
    <header className="flex items-center justify-between border-b border-border p-3"><h3>Product Strategy</h3>
      <button className="btn" onClick={onClose}>Close strategy</button></header>
    <ProductStrategyView teamPath={teamPath} view={view} sendMessage={sendMessage} connected={connected} />
  </aside>
}
