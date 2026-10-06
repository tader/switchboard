import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Link2, MoreHorizontal, Shield, ShieldOff, Trash2, UserPlus } from 'lucide-react';
import { api, type AdminUser } from '../api';
import { useSession } from '../auth';
import { Alert, Avatar, Badge, Button, Card, CopyField, Dialog, FormField, IconButton, Input, Menu, PageHeader, Select, Spinner, useConfirm, useToast } from '../components/ui';
import { ago, useResource } from '../lib';

export function Users() {
  const { user: me } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const users = useResource(() => api<AdminUser[]>('/admin/users'));
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<{ username: string; url: string; expiresAt: number; isNew: boolean } | null>(null);

  const patch = async (u: AdminUser, body: Partial<AdminUser>, done: string) => {
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
      users.reload();
      toast(done);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const invite = async (u: AdminUser) => {
    try {
      const r = await api(`/admin/users/${u.id}/invite`, { method: 'POST', body: {} });
      setLink({ username: u.username, ...r, isNew: false });
      users.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const remove = async (u: AdminUser) => {
    const ok = await confirm({
      title: `Delete ${u.username}?`,
      message: `Their ${u.connections} connection${u.connections === 1 ? '' : 's'}, tokens and saved calls are deleted too.`,
      confirm: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      users.reload();
      toast(`${u.username} deleted`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Users"
        actions={
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
            Add user
          </Button>
        }
      />
      {users.loading && !users.data ? (
        <div className="flex justify-center py-20">
          <Spinner className="size-5" />
        </div>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {users.data?.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-4 py-3">
                <Avatar label={u.username} className="size-8" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{u.username}</span>
                    {u.id === me.id && <span className="text-xs text-zinc-400">You</span>}
                    {u.role === 'admin' && <Badge tone="indigo">Admin</Badge>}
                    {u.disabled && <Badge tone="red">Disabled</Badge>}
                    {!u.disabled && !u.hasPassword && <Badge tone="amber">Invited</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {u.connections} connection{u.connections === 1 ? '' : 's'} · Joined {ago(u.createdAt).toLowerCase()}
                    {u.inviteExpiresAt && ` · Link expires ${ago(u.inviteExpiresAt).toLowerCase()}`}
                  </div>
                </div>
                <Menu
                  trigger={(p) => (
                    <IconButton label="Actions" {...p}>
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  )}
                  items={[
                    { label: u.hasPassword ? 'Password reset link' : 'New invite link', icon: <Link2 />, onSelect: () => invite(u) },
                    {
                      label: u.role === 'admin' ? 'Make member' : 'Make admin',
                      icon: u.role === 'admin' ? <ShieldOff /> : <Shield />,
                      hidden: u.id === me.id,
                      onSelect: () => patch(u, { role: u.role === 'admin' ? 'user' : 'admin' }, `${u.username} is now ${u.role === 'admin' ? 'a member' : 'an admin'}`),
                    },
                    {
                      label: u.disabled ? 'Enable' : 'Disable',
                      icon: u.disabled ? <CheckCircle2 /> : <Ban />,
                      hidden: u.id === me.id,
                      onSelect: () => patch(u, { disabled: !u.disabled }, u.disabled ? `${u.username} enabled` : `${u.username} disabled and signed out`),
                    },
                    'separator',
                    { label: 'Delete', icon: <Trash2 />, danger: true, hidden: u.id === me.id, onSelect: () => remove(u) },
                  ]}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}
      <AddUserDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(r) => {
          setAdding(false);
          users.reload();
          setLink({ username: r.user.username, ...r.invite, isNew: true });
        }}
      />
      <Dialog
        open={!!link}
        onClose={() => setLink(null)}
        title={link?.isNew ? `${link.username} was added` : `Link for ${link?.username}`}
        description={link && `Send this link to ${link.username}. It works once and expires ${ago(link.expiresAt).toLowerCase()}.`}
        footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}
      >
        {link && <CopyField value={link.url} />}
      </Dialog>
    </>
  );
}

function AddUserDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (r: any) => void }) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('user');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setUsername('');
      setRole('user');
      setError('');
    }
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title="Add user" description="They get a link to choose a password." size="sm">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            onAdded(await api('/admin/users', { body: { username, role } }));
          } catch (err: any) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormField label="Username" htmlFor="new-username">
          <Input id="new-username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required autoComplete="off" spellCheck={false} />
        </FormField>
        <FormField label="Role" htmlFor="new-role">
          <Select id="new-role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="user">Member — connects their own accounts</option>
            <option value="admin">Admin — also manages plugins and users</option>
          </Select>
        </FormField>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Add user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
