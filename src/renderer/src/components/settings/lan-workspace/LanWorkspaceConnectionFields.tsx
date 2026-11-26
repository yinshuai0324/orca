// @protected-copy
import type { ComponentProps } from 'react'
import { FolderOpen } from 'lucide-react'
import type { LanWorkspaceProject } from '../../../../../shared/remote-runtime/lan-workspace/lan-workspace-api'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { DialogDisclosure } from '@/components/ui/dialog-parts'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function ConnectionField({
  label,
  field,
  draft,
  onChange,
  children,
  required = true,
  ...inputProps
}: Omit<ComponentProps<typeof Input>, 'id' | 'onChange' | 'value'> & {
  label: string
  field: keyof LanWorkspaceProject
  draft: LanWorkspaceProject
  onChange: (field: keyof LanWorkspaceProject, value: string) => void
}): React.JSX.Element {
  const id = `lan-workspace-${field}`
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          {...inputProps}
          id={id}
          value={draft[field]}
          onChange={(event) => onChange(field, event.target.value)}
          required={required}
        />
        {children}
      </div>
    </div>
  )
}

export function LanWorkspaceConnectionFields({
  draft,
  busy,
  onChange,
  onBrowse
}: {
  draft: LanWorkspaceProject
  busy: boolean
  onChange: (field: keyof LanWorkspaceProject, value: string) => void
  onBrowse: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const bindings = { draft, onChange }
  return (
    <fieldset className="grid gap-3" disabled={busy}>
      <ConnectionField
        {...bindings}
        field="directory"
        label={t('lanWorkspace.directory', 'Mac project folder')}
        spellCheck={false}
      >
        <Button type="button" variant="outline" size="sm" onClick={onBrowse}>
          <FolderOpen />
          {t('lanWorkspace.browse', 'Browse…')}
        </Button>
      </ConnectionField>
      <p className="text-xs text-muted-foreground">
        {t(
          'lanWorkspace.shareNote',
          'The remote host can edit this folder. Environment files, Git metadata, dependencies, and links stay on your Mac.'
        )}
      </p>
      <DialogDisclosure label={t('lanWorkspace.previewSettings', 'Mac preview settings')}>
        <p className="mb-3 text-xs text-muted-foreground">
          {t(
            'lanWorkspace.smbPreviewNote',
            'After the first save from a remote Mac, Orca runs this command locally and opens the preview. Clear either field to turn off automatic preview.'
          )}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <ConnectionField
            {...bindings}
            field="startCommand"
            label={t('lanWorkspace.command', 'Mac start command')}
            spellCheck={false}
            required={false}
          />
          <ConnectionField
            {...bindings}
            field="previewUrl"
            label={t('lanWorkspace.previewUrl', 'Preview URL')}
            inputMode="url"
            spellCheck={false}
            required={false}
          />
        </div>
      </DialogDisclosure>
    </fieldset>
  )
}
