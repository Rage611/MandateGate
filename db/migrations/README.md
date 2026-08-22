# db/migrations

SQL migration files for Supabase (PostgreSQL).

Files in this directory are numbered sequentially:

```
0001_initial_schema.sql   — Phase 1: mandates, merchants, agents tables
0002_...                  — subsequent phases
```

Run migrations manually via the Supabase dashboard SQL editor, or via the Supabase CLI:

```bash
supabase db push
```

_No migrations yet — first migration created in Phase 1 alongside the mandate schema._
