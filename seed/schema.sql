-- The app's billing tables. Shape follows Vercel's nextjs-subscription-payments
-- starter (users, customers, products, prices, subscriptions), plus the
-- `entitlements` table most apps grow once access checks stop trusting the
-- subscriptions table alone. Access is decided by entitlements.plan; the
-- subscriptions rows are what the app last heard from Stripe's webhooks.
--
-- pnpm seed runs this file, so it starts by dropping these six tables. The seed
-- refuses to when users holds anyone it did not create.
drop table if exists entitlements, subscriptions, prices, products, customers, users cascade;

create table users (
  id uuid primary key,
  email text not null unique,
  full_name text,
  created_at timestamptz not null default now()
);

create table customers (
  id uuid primary key references users(id),
  stripe_customer_id text not null unique
);

create table products (
  id text primary key,
  name text not null,
  active boolean not null default true
);

create table prices (
  id text primary key,
  product_id text references products(id),
  unit_amount integer not null,
  currency text not null,
  "interval" text not null
);

create table subscriptions (
  id text primary key,
  user_id uuid not null references users(id),
  status text not null,
  price_id text references prices(id),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
create index subscriptions_user_id on subscriptions(user_id);

create table entitlements (
  user_id uuid primary key references users(id),
  plan text not null,
  source text not null,
  updated_at timestamptz not null default now()
);
