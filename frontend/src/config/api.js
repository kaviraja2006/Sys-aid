import axios from 'axios';
import axiosRetry from 'axios-retry';

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000';
const BACKEND_API_KEY = import.meta.env.VITE_BACKEND_API_KEY || '';

const api = axios.create({
  baseURL: API_URL,
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
