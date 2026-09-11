alter table public.contact_requests
  add constraint contact_requests_name_length
    check (length(btrim(name)) between 2 and 120),
  add constraint contact_requests_phone_length
    check (length(btrim(phone)) between 7 and 40),
  add constraint contact_requests_message_length
    check (length(btrim(message)) between 10 and 5000);
