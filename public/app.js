async function upload() {
  const file = document.getElementById('fileInput').files[0];
  if(!file) return alert('Choisis une ordonnance');
  const formData = new FormData();
  formData.append('prescription', file);
  
  const res = await fetch('/api/analyze', { method: 'POST', body: formData });
  const data = await res.json();
  
  const ex = data.explanations;
  document.getElementById('result').innerText = 
    `DRUGS: ${JSON.stringify(data.detected_drugs, null, 2)}\n\n` +
    `FON: ${ex.fon}\n\nFR: ${ex.fr}\n\nEN: ${ex.en}`;
}