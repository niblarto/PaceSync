export interface SpotifyTrack {
  id: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] };
  duration_ms: number;
  uri: string;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  images: { url: string }[];
  tracks: { total: number };
  owner: { display_name: string };
}

export interface AudioFeatures {
  id: string;
  tempo: number;
  energy: number;
  valence: number;
}

export interface TrackWithBPM extends SpotifyTrack {
  bpm: number;
  energy: number;
}

export interface HRZone {
  min: number;
  max: number;
}

export interface RunningZone {
  number: number;
  name: string;
  description: string;
  hrMin: number;
  hrMax: number;
  bpmMin: number;
  bpmMax: number;
  pace: string;
  color: string;
  textColor: string;
}

