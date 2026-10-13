-- Run this entire file in Supabase SQL Editor BEFORE uploading the website.
-- Safe to rerun: existing prices, stock and orders are preserved.
begin;
create schema if not exists hmtb_private;
revoke all on schema hmtb_private from public, anon, authenticated;
create table if not exists public.hmtb_menu (
 id integer primary key, name text not null, category text not null,
 price integer not null check(price between 0 and 100000),
 image text not null default '', description text not null default '',
 emoji text not null default '', sort_order integer not null,
 available boolean not null default true, extras jsonb not null default '[]'
);
create table if not exists public.hmtb_orders (
 id text primary key, request_id uuid unique not null,
 created_at timestamptz not null default now(), name text not null,
 phone text not null, address text not null, map text not null default '',
 payment text not null check(payment in ('COD','UPIQR')), items jsonb not null,
 total integer not null check(total>=0),
 status text not null default 'Awaiting WhatsApp confirmation'
 check(status in ('Awaiting WhatsApp confirmation','Received','Preparing','Ready','Out for delivery','Delivered','Cancelled'))
);
create table if not exists hmtb_private.daily_orders(day date primary key, next_number integer not null);
alter table public.hmtb_menu enable row level security;
alter table public.hmtb_orders enable row level security;
alter table hmtb_private.daily_orders enable row level security;
revoke all on public.hmtb_menu,public.hmtb_orders from anon,authenticated;
grant select on public.hmtb_menu to anon,authenticated;
grant update(price,available) on public.hmtb_menu to authenticated;
grant select on public.hmtb_orders to authenticated;
grant update(status) on public.hmtb_orders to authenticated;
drop policy if exists menu_read on public.hmtb_menu;
create policy menu_read on public.hmtb_menu for select to anon,authenticated using(true);
drop policy if exists menu_admin on public.hmtb_menu;
create policy menu_admin on public.hmtb_menu for update to authenticated
 using((select auth.uid())='2199f32b-7679-4405-8d4b-18f6aa65b72c'::uuid)
 with check((select auth.uid())='2199f32b-7679-4405-8d4b-18f6aa65b72c'::uuid);
drop policy if exists orders_admin_read on public.hmtb_orders;
create policy orders_admin_read on public.hmtb_orders for select to authenticated
 using((select auth.uid())='2199f32b-7679-4405-8d4b-18f6aa65b72c'::uuid);
drop policy if exists orders_admin_update on public.hmtb_orders;
create policy orders_admin_update on public.hmtb_orders for update to authenticated
 using((select auth.uid())='2199f32b-7679-4405-8d4b-18f6aa65b72c'::uuid)
 with check((select auth.uid())='2199f32b-7679-4405-8d4b-18f6aa65b72c'::uuid);
-- Customers can submit an order but cannot read order tables or supply prices.
create or replace function public.hmtb_place_order(
 p_request_id uuid,p_name text,p_phone text,p_address text,p_map text,
 p_payment text,p_items jsonb,p_expected_total integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 old_order public.hmtb_orders%rowtype;
 product public.hmtb_menu%rowtype;
 line jsonb; extra jsonb; key_value text; seen text[];
 amount integer; quantity integer; grand_total integer:=0;
 cooked_items jsonb:='[]'; label text; extras_label text;
 order_day date:=(now() at time zone 'Asia/Kolkata')::date;
 series integer; order_id text;
begin
 if p_request_id is null then raise exception 'Missing order reference'; end if;
 -- Serialise retries for one opaque request identifier.
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into old_order from public.hmtb_orders where request_id=p_request_id;
 if found then
  return jsonb_build_object('id',old_order.id,'items',old_order.items,'total',old_order.total);
 end if;
 if p_name is null or length(trim(p_name)) not between 1 and 100
 or p_phone is null or p_phone !~ '^[6-9][0-9]{9}$'
 or p_address is null or length(trim(p_address)) not between 1 and 1000
 or p_map is null or length(p_map)>2000
 or (p_map<>'' and p_map !~ '^https?://')
 or p_payment is null or p_payment not in ('COD','UPIQR') then
  raise exception 'Please check your contact and delivery details';
 end if;
 if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'Invalid cart'; end if;
 if jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Invalid cart size'; end if;
 for line in select value from jsonb_array_elements(p_items) loop
  if (line->>'qty') is null or (line->>'qty') !~ '^[0-9]{1,2}$'
  or (line->>'id') is null or (line->>'id') !~ '^[0-9]{1,6}$' then raise exception 'Invalid item'; end if;
  quantity:=(line->>'qty')::integer;
  if quantity not between 1 and 50 then raise exception 'Quantity must be between 1 and 50'; end if;
  select * into product from public.hmtb_menu where id=(line->>'id')::integer for share;
  if not found then raise exception 'An item is no longer available'; end if;
  if not product.available then raise exception '% is out of stock',product.name; end if;
  amount:=product.price; label:=product.name; seen:=array[]::text[]; extras_label:='';
  if line->'extras' is null or jsonb_typeof(line->'extras')<>'array' then raise exception 'Invalid add-ons'; end if;
  if jsonb_array_length(line->'extras')>7 then raise exception 'Too many add-ons'; end if;
  for key_value in select value from jsonb_array_elements_text(line->'extras') loop
   if key_value=any(seen) then raise exception 'Duplicate add-on'; end if;
   select value into extra from jsonb_array_elements(product.extras) where value->>'key'=key_value;
   if not found then raise exception 'Invalid add-on for %',product.name; end if;
   seen:=array_append(seen,key_value);amount:=amount+(extra->>'price')::integer;
   extras_label:=extras_label||case when extras_label='' then '' else ', ' end||(extra->>'name')||' +₹'||(extra->>'price');
  end loop;
  if extras_label<>'' then label:=label||' [Add-ons: '||extras_label||']'; end if;
  grand_total:=grand_total+amount*quantity;
  cooked_items:=cooked_items||jsonb_build_array(jsonb_build_object('name',label,'qty',quantity,'price',amount));
 end loop;
 if p_expected_total is null or grand_total<>p_expected_total then raise exception 'Prices have changed. Review your cart again.'; end if;
 insert into hmtb_private.daily_orders(day,next_number) values(order_day,1)
 on conflict(day) do update set next_number=hmtb_private.daily_orders.next_number+1
 returning next_number into series;
 order_id:='HMTB-'||to_char(order_day,'YYYYMMDD')||'-'||case when series<1000 then lpad(series::text,3,'0') else series::text end;
 insert into public.hmtb_orders(id,request_id,name,phone,address,map,payment,items,total)
 values(order_id,p_request_id,trim(p_name),p_phone,trim(p_address),p_map,p_payment,cooked_items,grand_total);
 return jsonb_build_object('id',order_id,'items',cooked_items,'total',grand_total);
end;$$;
revoke all on function public.hmtb_place_order(uuid,text,text,text,text,text,jsonb,integer) from public;
grant execute on function public.hmtb_place_order(uuid,text,text,text,text,text,jsonb,integer) to anon,authenticated;

-- Initial menu and server-approved extras.
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(1,'Loaded (6 slices) — Classic Veg Cheese Pizza','Pizza',120,'corn-cheese-pizza-new.jpg','Loaded (6 slices)','🍕',0,'[{"key": "cheese", "name": "Extra cheese", "price": 20}, {"key": "seasoning", "name": "Extra oregano & chilli flakes sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(2,'Loaded (6 slices) — Corn Cheese Pizza','Pizza',140,'corn-cheese-pizza.jpg','Loaded (6 slices)','🍕',1,'[{"key": "corn", "name": "Extra corn", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 20}, {"key": "seasoning", "name": "Extra oregano & chilli flakes sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(3,'Loaded (6 slices) — Paneer Cheese Pizza','Pizza',160,'paneer-pizza.jpg','Loaded (6 slices)','🍕',2,'[{"key": "paneer", "name": "Extra paneer", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 20}, {"key": "seasoning", "name": "Extra oregano & chilli flakes sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(4,'Loaded (6 slices) — Magaritta Pizza','Pizza',180,'magaritta-pizza.jpg','Loaded (6 slices)','🍕',3,'[{"key": "corn", "name": "Extra corn", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}, {"key": "seasoning", "name": "Extra oregano & chilli flakes sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(108,'Loaded (6 slices) — Cheese Burst Pizza','Pizza',200,'cheese-burst-pizza.jpg','Loaded (6 slices)','🍕',4,'[{"key": "cheese", "name": "Extra cheese", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}, {"key": "seasoning", "name": "Extra oregano & chilli flakes sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(5,'Loaded (6 slices) — Chicken Cheese Pizza','Pizza',180,'chicken-cheese-pizza.jpg','Loaded (6 slices)','🍕',5,'[{"key": "cheese", "name": "Extra cheese", "price": 20}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "seasoning", "name": "Extra oregano & chilli flakes sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(6,'Mini (4 slices) — Classic Veg Cheese Pizza','Pizza',80,'corn-cheese-pizza-new.jpg','Mini (4 slices)','🍕',6,'[{"key": "cheese", "name": "Extra cheese", "price": 20}, {"key": "seasoning", "name": "Extra oregano & chilli flakes sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(7,'Mini (4 slices) — Corn Cheese Pizza','Pizza',100,'corn-cheese-pizza.jpg','Mini (4 slices)','🍕',7,'[{"key": "corn", "name": "Extra corn", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 20}, {"key": "seasoning", "name": "Extra oregano & chilli flakes sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(8,'Mini (4 slices) — Paneer Cheese Pizza','Pizza',120,'paneer-pizza.jpg','Mini (4 slices)','🍕',8,'[{"key": "paneer", "name": "Extra paneer", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 20}, {"key": "seasoning", "name": "Extra oregano & chilli flakes sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(9,'Mini (4 slices) — Chicken Cheese Pizza','Pizza',140,'chicken-cheese-pizza.jpg','Mini (4 slices)','🍕',9,'[{"key": "cheese", "name": "Extra cheese", "price": 20}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "seasoning", "name": "Extra oregano & chilli flakes sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(18,'Bombay Style (Regular) — Veg Sandwich','Sandwiches',35,'bombay-style-sandwich.jpg','Bombay Style (Regular)','🥪',10,'[{"key": "corn", "name": "Extra corn", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(19,'Bombay Style (Regular) — Chicken Sandwich','Sandwiches',60,'bombay-style-sandwich.jpg','Bombay Style (Regular)','🥪',11,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(20,'Bombay Style (Regular) — Cheese Sandwich','Sandwiches',50,'bombay-style-sandwich.jpg','Bombay Style (Regular)','🥪',12,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(21,'Bombay Style (Regular) — Chicken Cheese Sandwich','Sandwiches',70,'bombay-style-sandwich.jpg','Bombay Style (Regular)','🥪',13,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(22,'Grilled Style (Jumbo) — Veg Corn Sandwich','Sandwiches',60,'veg-corn-cheese-sandwich.jpg','Grilled Style (Jumbo)','🥪',14,'[{"key": "corn", "name": "Extra corn", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(23,'Grilled Style (Jumbo) — Veg Corn Cheese Sandwich','Sandwiches',70,'veg-corn-cheese-sandwich.jpg','Grilled Style (Jumbo)','🥪',15,'[{"key": "corn", "name": "Extra corn", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(24,'Grilled Style (Jumbo) — Paneer Sandwich','Sandwiches',70,'paneer-cheese-sandwich.jpg','Grilled Style (Jumbo)','🥪',16,'[{"key": "paneer", "name": "Extra paneer", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(25,'Grilled Style (Jumbo) — Paneer Cheese Sandwich','Sandwiches',80,'paneer-cheese-sandwich.jpg','Grilled Style (Jumbo)','🥪',17,'[{"key": "paneer", "name": "Extra paneer", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(26,'Grilled Style (Jumbo) — Chicken Sandwich','Sandwiches',80,'chicken-cheese-sandwich-grilled.jpg','Grilled Style (Jumbo)','🥪',18,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(27,'Grilled Style (Jumbo) — Chicken Cheese Sandwich','Sandwiches',90,'chicken-cheese-sandwich-grilled.jpg','Grilled Style (Jumbo)','🥪',19,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(28,'Grilled Style (Jumbo) — Mix Triple Bread Sandwich','Sandwiches',120,'veg-corn-cheese-sandwich.jpg','Grilled Style (Jumbo)','🥪',20,'[{"key": "paneer", "name": "Extra paneer", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(29,'Regular — Veg Burger','Burgers',50,'veg-cheese-burger.jpg','Regular','🍔',21,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(30,'Regular — Veg Cheese Burger','Burgers',60,'veg-cheese-burger.jpg','Regular','🍔',22,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(31,'Regular — Chicken Burger','Burgers',80,'chicken-burger.jpg','Regular','🍔',23,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(32,'Regular — Chicken Cheese Burger','Burgers',90,'chicken-burger.jpg','Regular','🍔',24,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(33,'Regular — Crispy Chicken Burger','Burgers',90,'crispy-chicken-cheese-burger.jpg','Regular','🍔',25,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(34,'Regular — Crispy Chicken Cheese Burger','Burgers',100,'crispy-chicken-cheese-burger.jpg','Regular','🍔',26,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(35,'Jumbo — Chicken Cheese Burger','Burgers',110,'chicken-burger.jpg','Jumbo','🍔',27,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(36,'Jumbo — Crispy Chicken Cheese Burger','Burgers',120,'crispy-chicken-cheese-burger.jpg','Jumbo','🍔',28,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(37,'KFC Style — Chicken Strips (5 pcs)','Chicken',100,'chicken-strips.jpg','KFC Style','🍗',29,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(38,'KFC Style — Chicken Popcorn (8 pcs)','Chicken',70,'corn.jpg','KFC Style','🍗',30,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(39,'Regular — Spring Veg Paneer Roll','Spring Rolls',20,'veg-soring-roll.jpg','Regular','🌯',31,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(40,'Regular — Spring Chicken Roll','Spring Rolls',35,'chicken-spring-roll.jpg','Regular','🌯',32,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(41,'Single Tortilla — Veg Corn Cheese Wrap','Wraps',90,'veg-corn-wrap.jpg','Single Tortilla','🌯',33,'[{"key": "corn", "name": "Extra corn", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(42,'Single Tortilla — Paneer Cheese Wrap','Wraps',100,'paneer-wrap.jpg','Single Tortilla','🌯',34,'[{"key": "paneer", "name": "Extra paneer", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(43,'Single Tortilla — Chicken Cheese Wrap','Wraps',110,'chicken-wrap.jpg','Single Tortilla','🌯',35,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(44,'Single Tortilla — Crispy Chicken Cheese Wrap','Wraps',130,'chicken-wrap.jpg','Single Tortilla','🌯',36,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(45,'Single Tortilla — Mix Wrap (Cochipa Wrap)','Wraps',120,'cochipa-wrap.jpg','Single Tortilla','🌯',37,'[{"key": "paneer", "name": "Extra paneer", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(46,'Double Tortilla — Veg Corn Cheese Wrap','Wraps',120,'veg-corn-wrap.jpg','Double Tortilla','🌯',38,'[{"key": "corn", "name": "Extra corn", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(47,'Double Tortilla — Paneer Cheese Wrap','Wraps',130,'paneer-wrap.jpg','Double Tortilla','🌯',39,'[{"key": "paneer", "name": "Extra paneer", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(48,'Double Tortilla — Chicken Cheese Wrap','Wraps',140,'chicken-wrap.jpg','Double Tortilla','🌯',40,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(49,'Double Tortilla — Crispy Chicken Cheese Wrap','Wraps',160,'chicken-wrap.jpg','Double Tortilla','🌯',41,'[{"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(50,'Double Tortilla — Mix Wrap (Cochipa Wrap)','Wraps',150,'cochipa-wrap.jpg','Double Tortilla','🌯',42,'[{"key": "paneer", "name": "Extra paneer", "price": 20}, {"key": "cheese", "name": "Extra cheese", "price": 10}, {"key": "chicken", "name": "Extra chicken", "price": 20}, {"key": "mayo", "name": "Extra mayo sachet", "price": 5}, {"key": "ketchup", "name": "Extra ketchup sachet", "price": 5}]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(51,'Fried — Mix Veg Momo (4 pcs)','Fry & Sides',50,'fried-momo.jpg','Fried','🍟',43,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(52,'Fried — Onion Rings (5 pcs)','Fry & Sides',50,'onion-rings.jpg','Fried','🍟',44,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(53,'Fried — Cheesy Corn Shots (5 pcs)','Fry & Sides',50,'pizza-bites.jpg','Fried','🍟',45,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(54,'Fried — Veg Cheeseball (5 pcs)','Fry & Sides',50,'cheeseball.jpg','Fried','🍟',46,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(55,'Fried — Veg Nuggets (7 pcs)','Fry & Sides',50,'veg-nuggets.jpg','Fried','🍟',47,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(56,'Fried — Smily (5 pcs)','Fry & Sides',50,'smily.jpg','Fried','🍟',48,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(57,'Fried — French Fries (Salted)','Fry & Sides',50,'salted-fries.jpg','Fried','🍟',49,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(58,'Fried — French Fries (Piri Piri)','Fry & Sides',60,'peri-peri-fries.jpg','Fried','🍟',50,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(59,'Shahi Tukda — Regular','Desserts',35,'shahi-tukda.jpg','Shahi Tukda','🍮',51,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(103,'Pulpy Mango','Drinks',25,'pulpy-mango-new.jpg','250 ML','🥤',52,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(104,'Pulpy Strawberry','Drinks',20,'pulpy-strawberry-new.jpg','200 ML','🥤',53,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(105,'Pulpy Watermelon','Drinks',20,'pulpy-watermelon-new.jpg','200 ML','🥤',54,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(106,'Pulpy Litchi','Drinks',20,'pulpy-litchi-new.jpg','200 ML','🥤',55,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(62,'Campa Cola','Drinks',10,'campa-cola-10-v2.jpg','Cold drink','🥤',56,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(63,'Campa Lemon','Drinks',10,'campa-lemon-10-v2.jpg','Cold drink','🥤',57,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(64,'Campa Orange','Drinks',10,'campa-orange-v2.jpg','Cold drink','🥤',58,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(107,'Independence Water Bottle — 750 ML','Drinks',15,'independence-water.jpg','750 ML','🥤',59,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(65,'Campa Cola','Drinks',20,'campa-cola-20-v2.jpg','Cold drink','🥤',60,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(66,'Campa Lemon','Drinks',20,'campa-lemon-20-v2.jpg','Cold drink','🥤',61,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(67,'Campa Orange','Drinks',20,'campa-orange-v2.jpg','Cold drink','🥤',62,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(68,'Campa Can','Drinks',30,'campa-can-new.jpg','Cold drink','🥤',63,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(69,'Appy Fizz','Drinks',10,'appy-fizz.jpg','Cold drink','🥤',64,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(70,'Paper Boat Anar','Drinks',20,'paper-boat-anar.jpg','Cold drink','🥤',65,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(71,'Pista Chuski (Lolli)','Ice Cream',10,'ice-pista-chuski-lolli-v2.jpg','Ice cream','🍦',66,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(72,'Pineapple Chuski (Lolli)','Ice Cream',10,'ice-pineapple-chuski-lolli-v2.jpg','Ice cream','🍦',67,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(73,'Strawberry Chuski (Lolli)','Ice Cream',10,'ice-strawberry-chuski-lolli-v2.jpg','Ice cream','🍦',68,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(74,'Mango Chuski (Lolli)','Ice Cream',10,'ice-mango-chuski-lolli-v2.jpg','Ice cream','🍦',69,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(75,'Vanilla Cup — 40 ML','Ice Cream',10,'ice-vanilla-cup-40-ml-v2.jpg','Ice cream','🍦',70,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(76,'Chilly Guava Fruit Bar (Candy)','Ice Cream',10,'ice-chilly-guava-fruit-bar-candy-v2.jpg','Ice cream','🍦',71,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(77,'Pineapple Fruit Bar (Candy)','Ice Cream',15,'ice-pineapple-fruit-bar-v3.jpg','Ice cream','🍦',72,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(78,'Strawberry Fruit Bar (Candy)','Ice Cream',20,'ice-strawberry-fruit-bar-v3.jpg','Ice cream','🍦',73,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(79,'Mango Fruit Bar (Candy)','Ice Cream',25,'ice-mango-fruit-bar-v3.jpg','Ice cream','🍦',74,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(80,'Milk Bar','Ice Cream',20,'ice-milk-bar-pista-20rs-new.jpg','Ice cream','🍦',75,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(81,'Vanilla Ball','Ice Cream',20,'ice-vanilla-ball-new.jpg','Ice cream','🍦',76,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(82,'Vanilla Mini Merry Cone','Ice Cream',20,'ice-vanilla-cone-20rs-1-new.jpg','Ice cream','🍦',77,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(83,'Chocolate Mini Merry Cone','Ice Cream',30,'ice-chocolate-mini-merry-cone-v2.jpg','Ice cream','🍦',78,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(84,'Pista Mini Merry Cone','Ice Cream',30,'ice-pista-cone-new.jpg','Ice cream','🍦',79,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(85,'Alophonso Bar','Ice Cream',35,'ice-alophonso-bar-v2.jpg','Ice cream','🍦',80,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(86,'Chocolate Bar','Ice Cream',35,'ice-chocobar-35rs-new.jpg','Ice cream','🍦',81,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(87,'Kulfi Bar','Ice Cream',40,'ice-kulfi-ar-40rs-new.jpg','Ice cream','🍦',82,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(88,'Butter Scotch Merry Cone','Ice Cream',50,'ice-butter-scotch-merry-cone-v2.jpg','Ice cream','🍦',83,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(89,'Strawberry Fruit Filled Cone','Ice Cream',50,'ice-strawberry-cone-50rs-1-new.jpg','Ice cream','🍦',84,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(109,'Passion Fruit Cone','Ice Cream',50,'ice-passion-fruit-new.jpg','Passion fruit flavoured cone','🍦',85,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(90,'Blueberry Fruit Filled Cone','Ice Cream',60,'ice-blueberry-cone-60rs-1-new.jpg','Ice cream','🍦',86,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(91,'Mini Tub Chikoo','Ice Cream',50,'ice-mini-tub-chikoo-new.jpg','Ice cream','🍦',87,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(92,'Mini Tub Kiwi','Ice Cream',50,'ice-kiwi-mini-tub-v2.jpg','Ice cream','🍦',88,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(113,'Mini Tub Strawberry','Ice Cream',50,'ice-mini-tub-strawberry-v3.jpg','Ice cream','🍦',89,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(112,'Mini Tub Alphonso Mango','Ice Cream',50,'ice-mini-tub-alphonso-mango-v3.jpg','Ice cream','🍦',90,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(93,'Mini Tub Sitaphal','Ice Cream',60,'ice-mini-tub-sitaphal-new.jpg','Ice cream','🍦',91,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(94,'Mini Tub Tender Coconut','Ice Cream',60,'ice-mini-tub-tender-coconut-new.jpg','125 ML','🍦',92,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(95,'Cassatta Queen','Ice Cream',50,'ice-casatta-new.jpg','Ice cream','🍦',93,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(97,'Majestica Premium Bar','Ice Cream',70,'ice-majestica-bar-70rs-new.jpg','Ice cream','🍦',94,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(98,'Ripple Premium Bar','Ice Cream',70,'ice-ripple-premium-bar-v2.jpg','Ice cream','🍦',95,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(99,'Velvetine Premium Bar','Ice Cream',40,'ice-velvetine-bar-40rs-1-new.jpg','Ice cream','🍦',96,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(100,'Cheesy Fries','Fry & Sides',100,'cheesy-fries.jpg','French fries topped with cheese','🍟',97,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(101,'Paper Boat Tender Coconut','Drinks',20,'paper-boat-tender-coconut.jpg','Cold drink','🥤',98,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(102,'Campa Energy Drink','Drinks',20,'campa-energy-drink.jpg','Cold drink','🥤',99,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(110,'Hana Lemon','Drinks',10,'hana-lemon.jpg','Cold drink','🥤',100,'[]'::jsonb) on conflict(id) do nothing;
insert into public.hmtb_menu(id,name,category,price,image,description,emoji,sort_order,extras) values(111,'Hana Ginger','Drinks',10,'hana-ginger.jpg','Cold drink','🥤',101,'[]'::jsonb) on conflict(id) do nothing;
commit;
select 'Setup complete' as result, count(*) as menu_items from public.hmtb_menu;
