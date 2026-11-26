import { defineFixture } from '../../component-fixtures/component-fixture'
import { AppRail } from './AppRail'

export const tall = defineFixture({
  width: 300,
  render: () => (
    <div className="flex bg-background" style={{ height: 420 }}>
      <AppRail listVisible />
      <div className="w-[220px] bg-worktree-sidebar" />
    </div>
  )
})
