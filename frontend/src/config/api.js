import axios from 'axios';
import axiosRetry from 'axios-retry';

const PROD_FALLBACK_API_URL = 'https://sys-aid-1.onrender.com';
const isLocalHost =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1');
const API_URL =
  import.meta.env.VITE_API_URL ||
  (isLocalHost ? 'http://127.0.0.1:8000' : PROD_FALLBACK_API_URL);
const BACKEND_API_KEY = import.meta.env.VITE_BACKEND_API_KEY || '';

const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
  headers: {
      'X-API-Key': BACKEND_API_KEY
  }
});

axiosRetry(api, { 
    retries: 3, 
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status >= 500;
    }
});

export { api, API_URL };
