ALTER TABLE pairing_requests DROP CONSTRAINT pairing_requests_requester_hash_fkey;
ALTER TABLE pairing_requests ADD COLUMN requester_device_id UUID REFERENCES devices(id) ON DELETE CASCADE;
