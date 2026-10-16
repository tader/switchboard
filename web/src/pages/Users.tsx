import { ListToolbar, ListFeedback, SortHeader, useList } from '../components/ListControls';
import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Link2, MoreHorizontal, Shield, ShieldOff, Trash2, UserPlus } from 'lucide-react';
import { api, type AdminUser } from '../api';
import { useSession } from '../auth';
import { Alert, Avatar, Badge, Button, CopyField, Dialog, FormField, IconButton, Input, Menu, PageHeader, Select, Table, useConfirm, useToast } from '../components/ui';
import { ago, useResource } from '../lib';

export function Users() {
  const { user: me } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const users = useResource(() => api<AdminUser[]>('/admin/users'));
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<{ username: string; url: string; expiresAt: number; isNew: boolean } | null>(null);

  const status = (u: AdminUser) => u.disabled ? 'disabled' : !u.hasPassword ? 'invited' : 'active';
  const list = useList('users', users.data ?? [], { search: u => [u.username], sorts: { name: u => u.username, role: u => u.role, status, joined: u => u.createdAt, connections: u => u.connections }, filters: { role: '', status: '' }, filter: (u, f) => (!f.role || u.role === f.role) && (!f.status || status(u) === f.status) });
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
      <div className="space-y-3">
        <ListToolbar list={list} label="users" sorts={[{ value: 'name', label: 'Name' }, { value: 'role', label: 'Role' }, { value: 'status', label: 'Status' }, { value: 'joined', label: 'Joined' }, { value: 'connections', label: 'Connections' }]}>
          <Select aria-label="User role" value={list.state.role} onChange={e => list.set({ role: e.target.value })} className="w-36"><option value="">Any role</option><option value="admin">Admin</option><option value="user">Member</option></Select>
          <Select aria-label="User status" value={list.state.status} onChange={e => list.set({ status: e.target.value })} className="w-36"><option value="">Any status</option><option value="active">Active</option><option value="invited">Invited</option><option value="disabled">Disabled</option></Select>
        </ListToolbar>
        <ListFeedback loading={users.loading && !users.data} error={users.error} empty={!list.visible.length} filtered={list.filtered} label="users" retry={users.reload} reset={list.reset} />
        {!!list.visible.length && <Table label="Users"><thead><tr><SortHeader list={list} field="name">User</SortHeader><SortHeader list={list} field="role" className="w-24">Role</SortHeader><SortHeader list={list} field="status" className="w-24">Status</SortHeader><SortHeader list={list} field="connections" className="hidden w-28 md:table-cell">Connections</SortHeader><SortHeader list={list} field="joined" className="hidden w-28 sm:table-cell">Joined</SortHeader><th className="w-11"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{list.visible.map(u => <tr key={u.id}>
            <td><div className="flex min-w-0 items-center gap-2.5"><Avatar label={u.username} /><span className="truncate font-medium">{u.username}</span>{u.id === me.id && <span className="text-xs text-zinc-400">You</span>}</div>{u.inviteExpiresAt && !u.hasPassword && <div className="mt-1 text-xs text-zinc-500">{u.inviteExpiresAt <= Date.now() ? 'Invite expired' : `Invite expires ${ago(u.inviteExpiresAt).toLowerCase()}`}</div>}</td>
            <td><Badge tone={u.role === 'admin' ? 'indigo' : 'neutral'}>{u.role === 'admin' ? 'Admin' : 'Member'}</Badge></td><td><Badge tone={u.disabled ? 'red' : !u.hasPassword ? 'amber' : 'green'}>{u.disabled ? 'Disabled' : !u.hasPassword ? 'Invited' : 'Active'}</Badge></td><td className="hidden tabular-nums text-zinc-500 md:table-cell">{u.connections}</td><td className="hidden text-xs text-zinc-500 sm:table-cell" title={new Date(u.createdAt).toLocaleString()}>{ago(u.createdAt)}</td>
            <td>                <Menu
                  trigger={(p) => (
                    <IconButton label={`Actions for ${u.username}`} {...p}>
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
                /></td></tr>)}</tbody>
        </Table>}
      </div>

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
