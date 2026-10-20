const express = require('express');
const cors = require('cors');
const multer = require('multer');
const app = express();

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// Simulation de ton futur function calling avec Meta
app.post('/api/analyze', upload.single('prescription'), async (req, res) => {
  console.log('Image reçue:', req.file.originalname);
  
  // SIMULATION de ce que fera SAM 3.1 + Spark
  // Le 26 tu remplaceras ce bloc par le vrai appel API
  const mockDrugs = [
    { name: "Paracetamol", dosage: "500mg" },
    { name: "Ibuprofene", dosage: "200mg" }
  ];

  // Ton idée avec Promise.all - tu la montres déjà ici
  const interactionChecks = mockDrugs.map(async (drug) => {
    // Simulation d'un check async
    return { drug: drug.name, safe: true };
  });

  const results = await Promise.all(interactionChecks);

    res.json({
    status: "success - MOCK",
    detected_drugs: mockDrugs,
    safety_check: results,
    explanations: {
      fon: "Amon, a gble Paracetamol kpodo Ibuprofene, enyon... E ma gble amon deji o.",
      fr: "Attention : Ne prenez pas Paracétamol et Ibuprofène ensemble à jeun, risque d'estomac.",
      en: "Warning: Avoid taking Paracetamol and Ibuprofen together on an empty stomach."
    }
  });
});

app.listen(3000, () => console.log('PharmaClear V0 running on http://localhost:3000'));