const API_URL = 'https://script.google.com/macros/s/AKfycbxcmAqb5ASUipihtlxfFbIeZ0Y2ITQ3cuG_q6s86zaxnFsXWTyYtss1NAC9hp8473GUeQ/exec';

export async function apiFetch(params = null, body = null, method = 'GET') {
  const url = new URL(API_URL);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const options = { method, headers: { 'Content-Type': 'application/json' }, redirect: 'follow' };
  if (body && method === 'POST') options.body = JSON.stringify(body);
  const res = await fetch(url.toString(), options);
  return await res.json();
}

export async function testInfo() {
  console.log('📡 Testing INFO...');
  const data = await apiFetch();
  console.log('✅ INFO:', JSON.stringify(data, null, 2));
  return data;
}

export async function testList() {
  console.log('\n📋 Testing LIST...');
  const data = await apiFetch({ action: 'list' });
  console.log('✅ LIST: success=', data.success, ', count=', data.data?.length || 0);
  if (data.data?.length) console.log('   First item ID:', data.data[0].id);
  return data;
}

export async function testDetail(id) {
  console.log('\n🔍 Testing DETAIL (ID:', id, ')...');
  const data = await apiFetch({ action: 'detail', id });
  console.log('✅ DETAIL: success=', data.success, ', nama=', data.data?.nama || 'N/A');
  return data;
}

export async function testCreate(payload) {
  console.log('\n➕ Testing CREATE...');
  const data = await apiFetch(null, payload, 'POST');
  console.log('✅ CREATE: success=', data.success);
  if (data.success) {
    console.log('   Generated ID:', data.data.id);
    console.log('   Total:', data.data.total);
    console.log('   Deposit:', data.data.deposit);
  } else {
    console.log('   Error:', data.error || data.message);
  }
  return data;
}

export async function runAllTests() {
  console.log('🚀 Starting Loka API Tests...\n');
  console.log('🔗 Base URL:', API_URL);
  console.log('='.repeat(60));
  
  try {
    await testInfo();
    const listRes = await testList();
    if (listRes.success && listRes.data?.length > 0) {
      await testDetail(listRes.data[0].id);
    }
    const createPayload = {
      nama: 'JS Fetch Test',
      whatsapp: '081234567890',
      tanggal: '2026-05-30',
      jam: '19:00',
      jumlah_orang: 10,
      area: 'Indoor',
      room_charge: false,
      extra_hour: 0,
      catatan: 'Test via await fetch'
    };
    const createRes = await testCreate(createPayload);
    if (createRes.success && createRes.data?.id) {
      await testDetail(createRes.data.id);
    }
    console.log('\n' + '='.repeat(60));
    console.log('✅ All tests completed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Auto-run jika file dijalankan langsung
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests();
}