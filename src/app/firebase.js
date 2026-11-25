// Firebase setup. The web config is a public client identifier, not a secret.
// There is no sign-in: access to the data is governed only by firestore.rules.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {
  getFirestore,
  collection,
  doc,
  onSnapshot,
  writeBatch,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyA_kaAFZtElUvI5kW3OGBAgCIj7_8az0rU',
  authDomain: 'abud-24577.firebaseapp.com',
  projectId: 'abud-24577',
  storageBucket: 'abud-24577.firebasestorage.app',
  messagingSenderId: '1008779618004',
  appId: '1:1008779618004:web:21e2562f450425d2137d41',
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

export { collection, doc, onSnapshot, writeBatch, serverTimestamp };

