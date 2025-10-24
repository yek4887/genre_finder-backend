// server/src/index.ts
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import SpotifyWebApi from 'spotify-web-api-node';
import 'dotenv/config';

// @ts-ignore
import { TrackObjectFull } from 'spotify-web-api-node-ts/src/types/SpotifyObjects';

const app = express();
app.use(express.json());

const corsOptions = {
  origin: 'https://genrefinder.xyz',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const isProduction = process.env.NODE_ENV === 'production';
const redirectUri = isProduction
  ? `${process.env.BACKEND_URL}/api/callback`
  : 'http://127.0.0.1:8080/api/callback';

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: redirectUri
});

app.get('/api/login', (req, res) => {
  const scopes = ['playlist-modify-public', 'playlist-modify-private'];
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, 'state-key', true);
  res.redirect(authorizeURL);
});

app.get('/api/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const data = await spotifyApi.authorizationCodeGrant(code as string);
    const { access_token, refresh_token } = data.body;
    res.redirect(`https://genrefinder.xyz?access_token=${access_token}&refresh_token=${refresh_token}`);
  } catch (err) {
    console.error('Callback Error:', err);
    res.status(400).send('Error getting tokens');
  }
});

app.post('/api/recommend-genres', async (req, res) => {
  const { query, accessToken } = req.body;
  if (!query) return res.status(400).json({ error: 'Query is required' });
  if (!accessToken) return res.status(401).json({ error: 'Access Token is required'});

  const userSpotifyApi = new SpotifyWebApi({ accessToken });

  try {
    let artist: any = null;

    const trackSearch = await userSpotifyApi.searchTracks(query, { limit: 1 });
    if (trackSearch.body.tracks && trackSearch.body.tracks.items.length > 0) {
      const trackArtistId = trackSearch.body.tracks.items[0].artists[0].id;
      const artistResponse = await userSpotifyApi.getArtist(trackArtistId);
      artist = artistResponse.body;
    } else {
      const artistSearch = await userSpotifyApi.searchArtists(query, { limit: 1 });
      if (artistSearch.body.artists && artistSearch.body.artists.items.length > 0) {
        artist = artistSearch.body.artists.items[0];
      }
    }

    // ▼▼▼ 순서가 수정되었습니다 ▼▼▼
    // 1. 아티스트가 존재하는지 '먼저' 확인합니다.
    if (!artist) {
      return res.status(404).json({ error: 'Artist or Track not found' });
    }
    
    // 2. 아티스트가 존재할 때만 '안전하게' 대표곡을 가져옵니다.
    const topTracksResponse = await userSpotifyApi.getArtistTopTracks(artist.id, 'US');
    const topTracks = topTracksResponse.body.tracks.slice(0, 5).map(track => ({
        name: track.name,
        url: track.external_urls.spotify,
        preview_url: track.preview_url
    }));
    // ▲▲▲ 순서가 수정되었습니다 ▲▲▲

    const prompt = `
      You are a world-class music curator. A user is searching for music related to "${artist.name}".
      Based on this artist's style, recommend 3 unique and interesting music genres.
      For each genre, provide a short, engaging description and 3 other representative artists.
      Do not recommend the genre "${artist.genres.join(', ')}" or the artist "${artist.name}".
      Provide the response strictly in JSON format like this, including spotifyTrackIds for each recommended artist's top track:
      {
        "genres": [
          { "name": "Genre Name", "description": "...", "artists": [...] },
          ...
        ]
      }
    `;
    
    const aiGenres = { /* ... (기존 예시 데이터와 동일) ... */ };

    const responseData = {
      searchedArtist: {
        name: artist.name,
        imageUrl: artist.images[0]?.url,
      },
      topTracks: topTracks,
      aiRecommendations: aiGenres.genres,
    };

    res.json(responseData);

  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

app.post('/api/save-playlist', async (req, res) => {
    const { accessToken, trackIds, artistName } = req.body;
    if (!accessToken || !trackIds || !artistName) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    const userSpotifyApi = new SpotifyWebApi({ accessToken });

    try {
        const playlistName = `${artistName} inspired by Genre Finder`;
        const playlist = await userSpotifyApi.createPlaylist(playlistName, {
            public: false,
            description: `AI recommended tracks based on ${artistName}. Created by Genre Finder.`
        });
        const playlistId = playlist.body.id;

        const spotifyTrackUris = trackIds.map((id: string) => `spotify:track:${id}`);
        await userSpotifyApi.addTracksToPlaylist(playlistId, spotifyTrackUris);

        res.status(200).json({ message: 'Playlist created successfully!', playlistUrl: playlist.body.external_urls.spotify });

    } catch (err) {
        console.error('Failed to create playlist', err);
        res.status(500).json({ error: 'Failed to create playlist.' });
    }
});

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});